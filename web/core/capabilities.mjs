const CAPABILITIES = Object.freeze({
  read: ["line.read", "incident.read", "report.read", "report.export", "notification.read"],
  incidentManagement: ["incident.create", "incident.update", "situation.manage"],
  providerCase: ["provider_case.draft", "provider_case.send"],
  administration: ["admin.manage", "admin.users", "admin.devices", "admin.policies"],
});

export function createCapabilityState(user) {
  const values = new Set(Array.isArray(user?.capabilities) ? user.capabilities : []);
  return {
    role: user?.role || null,
    roleLabel: user?.role_label || user?.role || null,
    scopes: Array.isArray(user?.scopes) ? user.scopes.slice() : [],
    capabilities: [...values],
    has(name) { return values.has(name); },
    canAny(names) { return names.some((name) => values.has(name)); },
    canRead(name) { return values.has(name) || values.has(`${name}.read`); },
  };
}

export function capabilityGroups() {
  return CAPABILITIES;
}
