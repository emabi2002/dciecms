class AccessDeniedError extends Error {
  constructor(message = 'Access denied') {
    super(message);
    this.name = 'AccessDeniedError';
    this.statusCode = 403;
  }
}

const ROLE_PERMISSIONS = Object.freeze({
  'REG': new Set(['party.create','party.view','party.search','filing.create','filing.view','filing.edit','filing.submit','filing.validate','filing.return','document.upload','document.view','task.view']),
  'REG-MGR': new Set(['party.create','party.view','party.search','filing.create','filing.view','filing.edit','filing.submit','filing.validate','filing.return','filing.reject','filing.accept','document.upload','document.view','task.view']),
  'FIN': new Set(['filing.view','finance.assess','finance.payment.create','finance.payment.view']),
  'FIN-MGR': new Set(['filing.view','finance.assess','finance.payment.create','finance.payment.view','finance.payment.confirm']),
  'LEGAL': new Set(['party.create','party.view','filing.create','filing.view','filing.edit','filing.submit','document.upload','document.view']),
  'PUBLIC': new Set(['party.create','party.view','filing.create','filing.view','filing.edit','filing.submit','document.upload','document.view']),
  'ICT-ADMIN': new Set(['user.create','user.disable','system.health.view','integration.manage']),
  'SEC-ADMIN': new Set(['user.create','user.disable','role.assign','permission.manage','access.grant','access.review','audit.view','security.alert.manage']),
  'MAG': new Set(['filing.view','case.view','document.view','judgment.create','judgment.review','judgment.sign','judgment.issue']),
  'CMAG': new Set(['filing.view','case.view','document.view','judgment.create','judgment.review','judgment.sign','judgment.issue','case.assign'])
});

function hasPermission(actor, permission) {
  return actor.roles.some(role => ROLE_PERMISSIONS[role]?.has(permission));
}

function authorize(actor, permission, context = {}) {
  if (!actor || !hasPermission(actor, permission)) {
    throw new AccessDeniedError(`Permission denied: ${permission}`);
  }
  if (context.courtId && !actor.courtIds.includes(context.courtId)) {
    throw new AccessDeniedError(`Access denied outside court scope: ${context.courtId}`);
  }
  if (context.explicitGrant && !actor.explicitGrants.includes(context.explicitGrant)) {
    throw new AccessDeniedError('Required explicit grant is missing');
  }
  return true;
}

module.exports = { authorize, hasPermission, AccessDeniedError, ROLE_PERMISSIONS };
