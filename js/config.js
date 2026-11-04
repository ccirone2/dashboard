// Address of the dashboard API (Cloud Run service "power-dashboard" in farm-gather-cloud).
// The API must list this site's origin (https://ccirone2.github.io) in ALLOWED_ORIGINS.
// For local development, open the page with ?api=http://127.0.0.1:8080 instead of editing this.
window.DASHBOARD_CONFIG = {
    apiBase: 'https://power-dashboard-770273654276.us-central1.run.app',
};
