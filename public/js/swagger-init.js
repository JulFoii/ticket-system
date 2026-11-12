(function () {
  "use strict";
  window.ui = SwaggerUIBundle({
    url: "/api/openapi.json",
    dom_id: "#swagger-ui",
    deepLinking: true,
    displayRequestDuration: true,
    filter: true,
    persistAuthorization: false,
    tryItOutEnabled: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    layout: "BaseLayout",
  });
})();
