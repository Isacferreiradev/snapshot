'use strict';

const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN || 'https://e1b31e329b6b83fa6e77aa8ae98f70f4@o4511063161307136.ingest.us.sentry.io/4511063164125184',
  environment: process.env.NODE_ENV || 'development',
  sendDefaultPii: false,
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  beforeSend(event) {
    // Remove PII from request data before sending to Sentry
    if (event.request) {
      delete event.request.cookies;
      if (event.request.headers) {
        delete event.request.headers['x-access-code'];
        delete event.request.headers['authorization'];
        delete event.request.headers['cookie'];
      }
    }
    if (event.user) delete event.user;
    return event;
  },
});
