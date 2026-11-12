'use strict';

/**
 * Suppresses only the irrelevant WebAuthn capability probes emitted by Node.
 * The guard makes repeated app imports safe in test runners.
 */
function suppressUnusedWebauthnExperimentalWarnings(processObject = process) {
    if (processObject.emitWarning.__ticketSystemFiltered) return;

    const originalEmitWarning = processObject.emitWarning.bind(processObject);
    function filteredEmitWarning(warning, typeOrOptions, ...rest) {
        const message = typeof warning === 'string' ? warning : warning?.message;
        const type = typeof typeOrOptions === 'string' ? typeOrOptions : typeOrOptions?.type;
        if (type === 'ExperimentalWarning' && /Web Crypto API|ML-DSA/.test(message ?? '')) {
            return;
        }
        return originalEmitWarning(warning, typeOrOptions, ...rest);
    }
    filteredEmitWarning.__ticketSystemFiltered = true;
    processObject.emitWarning = filteredEmitWarning;
}

module.exports = { suppressUnusedWebauthnExperimentalWarnings };
