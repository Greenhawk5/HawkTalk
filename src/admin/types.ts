// Phase 9 Admin CMS domain types. Transport-independent: no Telegram types
// appear anywhere in this layer (the Telegram UI adapts to these shapes).

export type AdminRole = 'OWNER' | 'ADMIN';

export function isAdminRole(value: unknown): value is AdminRole {
  return value === 'OWNER' || value === 'ADMIN';
}

/** Actions the CMS can authorize. ORDERING matters nowhere; the matrix decides. */
export type AdminAction =
  | 'dashboard.view'
  | 'users.list'
  | 'users.inspect'
  | 'users.set_role'
  | 'users.set_status'
  | 'providers.list'
  | 'providers.inspect'
  | 'providers.set_enabled'
  | 'credentials.list'
  | 'credentials.set_enabled'
  | 'credentials.delete'
  | 'policies.list'
  | 'policies.update'
  | 'tools.list'
  | 'audit.list'
  | 'usage.view'
  | 'prices.edit';

/** The powers each admin role holds. Encoded explicitly; documented in SECURITY.md. */
export type AdminCapability =
  | 'view_dashboard'
  | 'view_users'
  | 'view_providers'
  | 'view_credentials'
  | 'view_policies'
  | 'view_tools'
  | 'view_audit'
  | 'manage_ordinary_users'   // role/status changes on USER/VIP targets
  | 'manage_providers'        // enable/disable providers and credentials
  | 'edit_ordinary_policies'  // quota/rate values for USER/VIP roles
  | 'view_usage'              // fleet usage/cost analytics (OWNER only)
  | 'edit_prices'             // per-model price configuration (OWNER only)
  | 'manage_privileged_users' // role/status changes on ADMIN/OWNER/BLOCKED targets; grant ADMIN/OWNER
  | 'edit_privileged_policies'// policy edits for ADMIN/OWNER/BLOCKED roles incl. bypass flags
  | 'delete_credentials';

const ADMIN_CAPABILITIES: readonly AdminCapability[] = [
  'view_dashboard', 'view_users', 'view_providers', 'view_credentials', 'view_policies',
  'view_tools', 'view_audit', 'manage_ordinary_users', 'manage_providers', 'edit_ordinary_policies',
];

const OWNER_CAPABILITIES: readonly AdminCapability[] = [
  ...ADMIN_CAPABILITIES,
  'manage_privileged_users', 'edit_privileged_policies', 'delete_credentials',
  'view_usage', 'edit_prices',
];

export function capabilitiesFor(role: AdminRole): readonly AdminCapability[] {
  return role === 'OWNER' ? OWNER_CAPABILITIES : ADMIN_CAPABILITIES;
}

const ACTION_CAPABILITY: Record<AdminAction, AdminCapability> = {
  'dashboard.view': 'view_dashboard',
  'users.list': 'view_users',
  'users.inspect': 'view_users',
  'users.set_role': 'manage_ordinary_users',
  'users.set_status': 'manage_ordinary_users',
  'providers.list': 'view_providers',
  'providers.inspect': 'view_providers',
  'providers.set_enabled': 'manage_providers',
  'credentials.list': 'view_credentials',
  'credentials.set_enabled': 'manage_providers',
  'credentials.delete': 'delete_credentials',
  'policies.list': 'view_policies',
  'policies.update': 'edit_ordinary_policies',
  'tools.list': 'view_tools',
  'audit.list': 'view_audit',
  'usage.view': 'view_usage',
  'prices.edit': 'edit_prices',
};

export function canPerform(role: AdminRole, action: AdminAction): boolean {
  return capabilitiesFor(role).includes(ACTION_CAPABILITY[action]);
}
