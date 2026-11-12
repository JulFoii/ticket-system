'use strict';

const { transaction } = require('../db-tx');

function registerAdminSecurityRoutes({
    app, loginLimiterGlobal, loginLimiterPerIp, supportUserStore, totpStore, log,
    auditLog, verifyTotp, ownerId, getCurrentAdminName, checkAuth, adminPageData,
    requireOwner, passwordStore, usernameStore, adminUsername, safeUsername, diff,
    setCurrentAdminName, rpIdAndOrigin, webauthnStore, generateRegistrationOptions,
    appName, safePasskeyLabel, verifyRegistrationResponse, safeCredentialId,
    generateAuthenticationOptions, verifyAuthenticationResponse, generateSecret,
    buildOtpauthUri, sessionStore,
}) {
    /* ------------------------------------------------------ Admin-Login -- */

    app.get('/login', (req, res) => {
        // ?idle=1 kommt ausschliesslich vom eigenen checkAuth-Redirect nach
        // Session-Idle-Timeout (siehe oben) — kein Nutzereingriff moeglich,
        // der Text ist fest verdrahtet.
        const error = req.query.idle === '1' ? 'Wegen Inaktivität abgemeldet. Bitte erneut anmelden.' : null;
        res.render('login', { error });
    });

    app.post('/login', loginLimiterGlobal, loginLimiterPerIp, async (req, res) => {
        const submittedUsername = String(req.body.username ?? '').trim();
        const record = supportUserStore.findByUsername(submittedUsername);
        // verifyPassword() rechnet auch bei unbekanntem Namen eine volle
        // scrypt-Runde und verhindert dadurch Username-Enumeration.
        const passwordOk = await supportUserStore.verifyPassword(req.body.password, record);
        const user = record ? supportUserStore.get(record.id) : null;

        if (user && !user.disabled && passwordOk) {
            const totpEnabled = user.isOwner && await totpStore.isEnabled();
            // Session-ID nach erfolgreichem Login neu vergeben (Fixation) —
            // auch wenn TOTP noch als zweiter Faktor aussteht: der erste
            // Faktor hat schon Vertrauen geschaffen, die alte, evtl. dem
            // Angreifer bekannte Session-ID darf ab hier nicht mehr gelten.
            req.session.regenerate(err => {
                if (err) {
                    log.error('Session regenerate error:', err);
                    return res.status(500).render('login', { error: 'Serverfehler.' });
                }
                if (totpEnabled) {
                    req.session.pendingTotp = true;
                    req.session.pendingSupportUserId = user.id;
                    return res.redirect('/login/totp');
                }
                req.session.loggedIn = true;
                req.session.supportUserId = user.id;
                req.session.supportUserName = user.displayName;
                req.session.lastActivity = Date.now();
                supportUserStore.recordLogin(user.id);
                auditLog.log('login_success', { ip: req.ip, username: submittedUsername });
                res.redirect('/admin');
            });
        } else {
            // Bewusst generisch — sonst liesse sich per Antwort erraten, ob
            // schon der Benutzername stimmte (Username-Enumeration).
            auditLog.log('login_failed', { ip: req.ip, username: submittedUsername });
            res.status(401).render('login', { error: 'Benutzername oder Passwort falsch.' });
        }
    });

    /*
     * Zweiter Faktor nach erfolgreichem Passwort-Login. Erreichbar nur mit
     * einer Session, die gerade den ersten Faktor bestanden hat
     * (req.session.pendingTotp) — ohne das gilt dieselbe Regel wie ueberall
     * sonst: kein gueltiger Zustand, zurueck zu /login. Gilt bewusst NICHT
     * fuer den Passkey-Login: eine WebAuthn-Anmeldung ist schon
     * Besitz+Verifikation und damit MFA-gleichwertig.
     */
    app.get('/login/totp', (req, res) => {
        if (!req.session || !req.session.pendingTotp) {
            return res.redirect('/login');
        }
        res.render('login-totp', { error: null });
    });

    app.post('/login/totp', loginLimiterGlobal, loginLimiterPerIp, async (req, res) => {
        if (!req.session || !req.session.pendingTotp) {
            return res.redirect('/login');
        }

        const token = String(req.body.token ?? '').trim();
        const secret = await totpStore.getSecret();
        // Ein 6-stelliger Code ist immer der TOTP-Pfad, alles andere wird als
        // Recovery-Code versucht (Format ist fuer Nutzer nicht auswendig zu
        // kennen, daher keine strengere Vorabpruefung noetig).
        const ok = /^\d{6}$/.test(token) && secret
            ? verifyTotp(secret, token)
            : await totpStore.consumeRecoveryCode(token);

        if (!ok) {
            auditLog.log('totp_login_failed', { ip: req.ip });
            return res.status(401).render('login-totp', { error: 'Code ungültig.' });
        }

        delete req.session.pendingTotp;
        const supportUserId = req.session.pendingSupportUserId || ownerId;
        delete req.session.pendingSupportUserId;
        req.session.loggedIn = true;
        req.session.supportUserId = supportUserId;
        req.session.supportUserName = supportUserStore.get(supportUserId)?.displayName || getCurrentAdminName();
        req.session.lastActivity = Date.now();
        supportUserStore.recordLogin(supportUserId);
        auditLog.log('totp_login_success', { ip: req.ip });
        res.redirect('/admin');
    });

    /* ------------------------------------------------- Admin-Dashboard -- */

    app.get('/admin', checkAuth, async (req, res, next) => {
        if (req.supportUser.role !== 'admin') return res.redirect('/admin/tickets?assigned=mine');
        try {
            res.render('admin', await adminPageData());
        } catch (err) {
            next(err);
        }
    });

    /*
     * Bewusst ohne erneute Eingabe des alten Passworts — eine gueltige
     * Sitzung (egal ob per Passwort oder Passkey zustandegekommen) gilt als
     * Nachweis, dasselbe Vertrauensmodell wie bei der Passkey-Registrierung
     * unten. Wer das Sitzungscookie hat, hat ohnehin schon vollen
     * Admin-Zugriff — das alte Passwort zusaetzlich abzufragen wuerde
     * keinen Angriff verhindern, aber genau den Fall blockieren, fuer den
     * diese Route gedacht ist: das Passwort vergessen zu haben.
     */
    const MIN_PASSWORD_LENGTH = 8;

    // JS-Client schickt Accept: application/json und bekommt eine JSON-
    // Rueckmeldung fuer das Modal (public/js/account-forms.js); ohne JS
    // bleibt der Form-Submit-Weg (Redirect bzw. Inline-Fehler). Dieselbe
    // Logik gilt fuer /admin-username unten.
    app.post('/admin-password', requireOwner, async (req, res, next) => {
        const wantsJson = req.accepts(['html', 'json']) === 'json';
        const password = String(req.body.password ?? '');
        const confirmPassword = String(req.body.confirmPassword ?? '');
        const error =
            password.length < MIN_PASSWORD_LENGTH
                ? `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`
                : password !== confirmPassword
                    ? 'Die Passwörter stimmen nicht überein.'
                    : null;

        if (error) {
            if (wantsJson) return res.status(400).json({ error });
            try {
                return res.status(400).render('admin', await adminPageData({ passwordError: error }));
            } catch (err) {
                return next(err);
            }
        }

        try {
            await passwordStore.setPassword(password);
            await supportUserStore.ensureOwner({
                username: (await usernameStore.read()) ?? adminUsername,
                passwordRecord: await passwordStore.read(),
            });
            sessionStore.destroyForSupportUser(ownerId, req.sessionID);
            auditLog.log('password_changed', { ip: req.ip });
            if (wantsJson) return res.json({ ok: true });
            res.redirect('/admin#tab-account');
        } catch (err) {
            next(err);
        }
    });

    app.post('/admin-username', requireOwner, async (req, res, next) => {
        const wantsJson = req.accepts(['html', 'json']) === 'json';
        const username = safeUsername(req.body.username);

        if (!username) {
            const error = 'Ungültiger Benutzername (1–64 Zeichen, keine Leerzeichen).';
            if (wantsJson) return res.status(400).json({ error });
            try {
                return res.status(400).render('admin', await adminPageData({ usernameError: error }));
            } catch (err) {
                return next(err);
            }
        }

        try {
            const previous = (await usernameStore.read()) ?? adminUsername;
            const existing = supportUserStore.findByUsername(username);
            if (existing && existing.id !== ownerId) {
                const error = 'Dieser Benutzername ist bereits vergeben.';
                if (wantsJson) return res.status(409).json({ error });
                return res.status(409).render('admin', await adminPageData({ usernameError: error }));
            }
            const passwordRecord = await passwordStore.read();
            transaction(usernameStore.db, () => {
                usernameStore.write(username);
                supportUserStore.ensureOwner({ username, passwordRecord });
            });
            setCurrentAdminName(username);
            auditLog.log('username_changed', {
                ip: req.ip, username, changes: diff({ username: previous }, { username }),
            });
            if (wantsJson) return res.json({ ok: true });
            res.redirect('/admin#tab-account');
        } catch (err) {
            next(err);
        }
    });

    /* ------------------------------------------------- WebAuthn/Passkeys --
       Registrierung nur fuer bereits angemeldete Admins (checkAuth) — es
       gibt bewusst keinen separaten Bootstrap-Flow, der erste Passkey wird
       immer per Passwort-Login freigeschaltet. Die Login-Routen sind
       oeffentlich, teilen sich aber dieselben Rate-Limiter-Instanzen wie
       /login: ein Angreifer kann sein Budget nicht verdoppeln, indem er
       zwischen Passwort- und Passkey-Versuchen wechselt. */

    const PASSKEY_LOGIN_FAILED = { error: 'Anmeldung fehlgeschlagen.' };

    app.post('/webauthn/register/options', requireOwner, async (req, res, next) => {
        try {
            const { rpID } = rpIdAndOrigin(req);
            const userId = await webauthnStore.getOrCreateUserId();
            const existing = await webauthnStore.listCredentials();
            const options = await generateRegistrationOptions({
                rpName: appName,
                rpID,
                userName: 'admin',
                userID: Buffer.from(userId, 'base64url'),
                attestationType: 'none',
                excludeCredentials: existing.map(c => ({
                    id: c.credentialId, transports: c.transports,
                })),
                authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
            });
            req.session.webauthnChallenge = options.challenge;
            res.json(options);
        } catch (err) {
            next(err);
        }
    });

    app.post('/webauthn/register/verify', requireOwner, async (req, res) => {
        const expectedChallenge = req.session.webauthnChallenge;
        if (!expectedChallenge) {
            return res.status(400).json({ error: 'Keine offene Registrierung.' });
        }
        const label = safePasskeyLabel(req.body.label)
            ?? `Passkey (${app.locals.formatDate(Date.now())})`;
        try {
            const { rpID, expectedOrigin } = rpIdAndOrigin(req);
            const verification = await verifyRegistrationResponse({
                response: req.body.credential,
                expectedChallenge,
                expectedOrigin,
                expectedRPID: rpID,
            });
            if (!verification.verified) {
                return res.status(400).json({ error: 'Registrierung fehlgeschlagen.' });
            }
            const { credential } = verification.registrationInfo;
            await webauthnStore.addCredential({
                credentialId: credential.id,
                publicKey: Buffer.from(credential.publicKey).toString('base64url'),
                counter: credential.counter,
                transports: credential.transports ?? [],
                label,
            });
            auditLog.log('passkey_registered', { ip: req.ip, label });
            res.status(201).json({ ok: true });
        } catch (err) {
            log.error('WebAuthn Registrierung fehlgeschlagen:', err);
            res.status(400).json({ error: 'Registrierung fehlgeschlagen.' });
        } finally {
            delete req.session.webauthnChallenge;
        }
    });

    app.get('/webauthn/credentials', requireOwner, async (req, res, next) => {
        try {
            res.json(await webauthnStore.listCredentials());
        } catch (err) {
            next(err);
        }
    });

    app.delete('/webauthn/credentials/:id', requireOwner, async (req, res) => {
        const id = safeCredentialId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Credential-ID.' });
        const removed = await webauthnStore.removeCredential(id);
        if (removed) auditLog.log('passkey_removed', { ip: req.ip, credentialId: id });
        res.status(removed ? 204 : 404).end();
    });

    app.post('/webauthn/login/options', loginLimiterGlobal, loginLimiterPerIp, async (req, res, next) => {
        try {
            const { rpID } = rpIdAndOrigin(req);
            const existing = await webauthnStore.listCredentials();
            const options = await generateAuthenticationOptions({
                rpID,
                allowCredentials: existing.map(c => ({
                    id: c.credentialId, transports: c.transports,
                })),
                userVerification: 'preferred',
            });
            // saveUninitialized:false verhindert nur, dass eine UNVERAENDERTE
            // Session gespeichert wird. Sobald hier eine Property gesetzt
            // wird, gilt die Session als modifiziert und wird trotzdem
            // gespeichert — auch ganz ohne vorherige Anmeldung.
            req.session.webauthnChallenge = options.challenge;
            res.json(options);
        } catch (err) {
            next(err);
        }
    });

    app.post('/webauthn/login/verify', loginLimiterGlobal, loginLimiterPerIp, async (req, res) => {
        const expectedChallenge = req.session.webauthnChallenge;
        if (!expectedChallenge) {
            return res.status(400).json({ error: 'Keine offene Anmeldung.' });
        }
        const credentialId = safeCredentialId(req.body?.credential?.id);
        const stored = credentialId ? await webauthnStore.findCredential(credentialId) : null;
        if (!stored) {
            delete req.session.webauthnChallenge;
            auditLog.log('passkey_login_failed', { ip: req.ip });
            return res.status(401).json({ error: 'Unbekannter Passkey.' });
        }
        try {
            const { rpID, expectedOrigin } = rpIdAndOrigin(req);
            const verification = await verifyAuthenticationResponse({
                response: req.body.credential,
                expectedChallenge,
                expectedOrigin,
                expectedRPID: rpID,
                credential: {
                    id: stored.credentialId,
                    publicKey: Buffer.from(stored.publicKey, 'base64url'),
                    counter: stored.counter,
                    transports: stored.transports,
                },
            });
            if (!verification.verified) {
                delete req.session.webauthnChallenge;
                auditLog.log('passkey_login_failed', { ip: req.ip });
                return res.status(401).json(PASSKEY_LOGIN_FAILED);
            }
            await webauthnStore.updateCounter(stored.credentialId, verification.authenticationInfo.newCounter);
            // Session-ID nach erfolgreichem Login neu vergeben (Fixation) —
            // dasselbe Muster wie /login. regenerate() ersetzt die Session
            // komplett, die Challenge wird damit automatisch entsorgt.
            req.session.regenerate(err => {
                if (err) {
                    log.error('Session regenerate error:', err);
                    return res.status(500).json({ error: 'Serverfehler.' });
                }
                req.session.loggedIn = true;
                req.session.supportUserId = ownerId;
                req.session.supportUserName = supportUserStore.get(ownerId)?.displayName || getCurrentAdminName();
                req.session.lastActivity = Date.now();
                supportUserStore.recordLogin(ownerId);
                auditLog.log('passkey_login_success', { ip: req.ip, credentialId: stored.credentialId });
                res.json({ ok: true, redirect: '/admin' });
            });
        } catch (err) {
            log.error('WebAuthn Anmeldung fehlgeschlagen:', err);
            delete req.session.webauthnChallenge;
            auditLog.log('passkey_login_failed', { ip: req.ip });
            res.status(401).json(PASSKEY_LOGIN_FAILED);
        }
    });

    /* --------------------------------------------------------------- TOTP --
       Zweiter Faktor fuer den Passwort-Login (siehe /login/totp oben).
       Registrierung/Deaktivierung nur fuer bereits angemeldete Admins,
       dasselbe Vertrauensmodell wie bei Passkeys und /admin-password: eine
       gueltige Sitzung ist Nachweis genug, keine erneute Passwortabfrage. */

    app.post('/totp/setup', requireOwner, async (req, res, next) => {
        try {
            const secret = generateSecret();
            // Nur in der Session, nicht persistiert — siehe lib/totp-store.js.
            req.session.totpSetupSecret = secret;
            const label = (await usernameStore.read()) ?? adminUsername;
            res.json({ secret, otpauthUrl: buildOtpauthUri({ secret, label, issuer: appName }) });
        } catch (err) {
            next(err);
        }
    });

    // Dieselben Limiter wie /login — nach checkAuth, damit nicht angemeldete
    // Anfragen den globalen Login-Bucket nicht leeren.
    app.post('/totp/confirm', requireOwner, loginLimiterGlobal, loginLimiterPerIp, async (req, res, next) => {
        const pendingSecret = req.session.totpSetupSecret;
        if (!pendingSecret) {
            return res.status(400).json({ error: 'Keine offene Einrichtung.' });
        }
        if (!verifyTotp(pendingSecret, req.body.token)) {
            return res.status(400).json({ error: 'Code ungültig.' });
        }
        try {
            const recoveryCodes = await totpStore.enable(pendingSecret);
            delete req.session.totpSetupSecret;
            auditLog.log('totp_enabled', { ip: req.ip });
            res.json({ ok: true, recoveryCodes });
        } catch (err) {
            next(err);
        }
    });

    app.post('/totp/disable', requireOwner, async (req, res, next) => {
        try {
            await totpStore.disable();
            auditLog.log('totp_disabled', { ip: req.ip });
            res.json({ ok: true });
        } catch (err) {
            next(err);
        }
    });

}

module.exports = { registerAdminSecurityRoutes };

