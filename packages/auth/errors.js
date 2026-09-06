'use strict';

class AuthenticationError extends Error {
  constructor(message = 'Authentication failed') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

class AuthenticationUnavailableError extends Error {
  constructor(message = 'Authentication service unavailable') {
    super(message);
    this.name = 'AuthenticationUnavailableError';
  }
}

module.exports = { AuthenticationError, AuthenticationUnavailableError };
