'use strict';

const PAYMENT_INTEGRATION_METHODS = Object.freeze([
  'createPaymentSession'
]);

function requirePaymentIntegrationService(instance) {
  const service = instance.paymentIntegration;
  if (!service) throw new TypeError('Payment integration is disabled or unavailable');
  return service;
}

function installPaymentIntegrationFacade(TargetClass) {
  for (const method of PAYMENT_INTEGRATION_METHODS) {
    if (Object.prototype.hasOwnProperty.call(TargetClass.prototype, method)) {
      throw new TypeError(`Payment integration facade cannot overwrite ${method}`);
    }
    Object.defineProperty(TargetClass.prototype, method, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: function paymentIntegrationDelegate(...args) {
        const service = requirePaymentIntegrationService(this);
        if (typeof service[method] !== 'function') {
          throw new TypeError(`Payment integration must expose ${method}()`);
        }
        return service[method](...args);
      }
    });
  }
  return TargetClass;
}

module.exports = {
  PAYMENT_INTEGRATION_METHODS,
  requirePaymentIntegrationService,
  installPaymentIntegrationFacade
};
