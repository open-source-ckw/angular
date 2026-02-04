// src/environments/environment.ts
export const environment = {
  production: false,
  firebase: {
    apiKey: "",
    authDomain: "",
    databaseURL: "",
    projectId: "",
    storageBucket: "",
    messagingSenderId: "",
    appId: ""
  },
  // Base URL for NestJS game endpoints
  apiBaseUrl: 'http://localhost:3000/game',
  // Base URL for SSE stream endpoints (if hosted separately, otherwise reuse apiBaseUrl)
  streamBaseUrl: 'http://localhost:3000/game',
  // Optional base URL for rules controller
  rulesBaseUrl: 'http://localhost:3000/rules',
};
