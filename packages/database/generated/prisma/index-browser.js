
Object.defineProperty(exports, "__esModule", { value: true });

const {
  Decimal,
  objectEnumValues,
  makeStrictEnum,
  Public,
  getRuntime,
  skip
} = require('./runtime/index-browser.js')


const Prisma = {}

exports.Prisma = Prisma
exports.$Enums = {}

/**
 * Prisma Client JS version: 5.22.0
 * Query Engine version: 605197351a3c8bdd595af2d2a9bc3025bca48ea2
 */
Prisma.prismaVersion = {
  client: "5.22.0",
  engine: "605197351a3c8bdd595af2d2a9bc3025bca48ea2"
}

Prisma.PrismaClientKnownRequestError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientKnownRequestError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)};
Prisma.PrismaClientUnknownRequestError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientUnknownRequestError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientRustPanicError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientRustPanicError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientInitializationError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientInitializationError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientValidationError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientValidationError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.NotFoundError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`NotFoundError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.Decimal = Decimal

/**
 * Re-export of sql-template-tag
 */
Prisma.sql = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`sqltag is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.empty = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`empty is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.join = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`join is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.raw = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`raw is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.validator = Public.validator

/**
* Extensions
*/
Prisma.getExtensionContext = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`Extensions.getExtensionContext is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.defineExtension = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`Extensions.defineExtension is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}

/**
 * Shorthand utilities for JSON filtering
 */
Prisma.DbNull = objectEnumValues.instances.DbNull
Prisma.JsonNull = objectEnumValues.instances.JsonNull
Prisma.AnyNull = objectEnumValues.instances.AnyNull

Prisma.NullTypes = {
  DbNull: objectEnumValues.classes.DbNull,
  JsonNull: objectEnumValues.classes.JsonNull,
  AnyNull: objectEnumValues.classes.AnyNull
}



/**
 * Enums
 */

exports.Prisma.TransactionIsolationLevel = makeStrictEnum({
  ReadUncommitted: 'ReadUncommitted',
  ReadCommitted: 'ReadCommitted',
  RepeatableRead: 'RepeatableRead',
  Serializable: 'Serializable'
});

exports.Prisma.TenantScalarFieldEnum = {
  id: 'id',
  name: 'name',
  slug: 'slug',
  plan: 'plan',
  status: 'status',
  settings: 'settings',
  metadata: 'metadata',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.UserScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  email: 'email',
  password: 'password',
  firstName: 'firstName',
  lastName: 'lastName',
  avatarUrl: 'avatarUrl',
  role: 'role',
  permissions: 'permissions',
  isActive: 'isActive',
  isVerified: 'isVerified',
  lastLoginAt: 'lastLoginAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.RefreshTokenScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  tokenHash: 'tokenHash',
  expiresAt: 'expiresAt',
  revokedAt: 'revokedAt',
  replacedByTokenId: 'replacedByTokenId',
  userAgent: 'userAgent',
  ipAddress: 'ipAddress',
  createdAt: 'createdAt'
};

exports.Prisma.OAuthAccountScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  provider: 'provider',
  providerAccountId: 'providerAccountId',
  accessToken: 'accessToken',
  refreshToken: 'refreshToken',
  expiresAt: 'expiresAt',
  tokenType: 'tokenType',
  scope: 'scope',
  idToken: 'idToken',
  rawProfile: 'rawProfile',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.ApiKeyScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  name: 'name',
  keyHash: 'keyHash',
  prefix: 'prefix',
  scopes: 'scopes',
  expiresAt: 'expiresAt',
  lastUsedAt: 'lastUsedAt',
  isActive: 'isActive',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.AuditLogScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  userId: 'userId',
  event: 'event',
  resource: 'resource',
  resourceId: 'resourceId',
  before: 'before',
  after: 'after',
  ipAddress: 'ipAddress',
  userAgent: 'userAgent',
  meta: 'meta',
  createdAt: 'createdAt'
};

exports.Prisma.BrandScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  name: 'name',
  slug: 'slug',
  logoUrl: 'logoUrl',
  settings: 'settings',
  metadata: 'metadata',
  isActive: 'isActive',
  deletedAt: 'deletedAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.LocationScalarFieldEnum = {
  id: 'id',
  brandId: 'brandId',
  name: 'name',
  externalRef: 'externalRef',
  address: 'address',
  phone: 'phone',
  timezone: 'timezone',
  isActive: 'isActive',
  settings: 'settings',
  metadata: 'metadata',
  deletedAt: 'deletedAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.IntegrationScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  platform: 'platform',
  status: 'status',
  credentials: 'credentials',
  settings: 'settings',
  webhookUrl: 'webhookUrl',
  syncMetadata: 'syncMetadata',
  lastSyncAt: 'lastSyncAt',
  lastErrorAt: 'lastErrorAt',
  lastError: 'lastError',
  deletedAt: 'deletedAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.MenuScalarFieldEnum = {
  id: 'id',
  brandId: 'brandId',
  name: 'name',
  isActive: 'isActive',
  deletedAt: 'deletedAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.MenuCategoryScalarFieldEnum = {
  id: 'id',
  menuId: 'menuId',
  name: 'name',
  sortOrder: 'sortOrder',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.MenuItemScalarFieldEnum = {
  id: 'id',
  brandId: 'brandId',
  name: 'name',
  description: 'description',
  basePrice: 'basePrice',
  imageUrl: 'imageUrl',
  sku: 'sku',
  isAvailable: 'isAvailable',
  modifierGroups: 'modifierGroups',
  allergens: 'allergens',
  calories: 'calories',
  metadata: 'metadata',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.MenuItemOnCategoryScalarFieldEnum = {
  categoryId: 'categoryId',
  itemId: 'itemId',
  sortOrder: 'sortOrder',
  priceOverride: 'priceOverride'
};

exports.Prisma.OrderScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  externalId: 'externalId',
  platform: 'platform',
  displayId: 'displayId',
  orderSource: 'orderSource',
  integrationSource: 'integrationSource',
  viaHubrise: 'viaHubrise',
  status: 'status',
  fulfillmentType: 'fulfillmentType',
  customerInfo: 'customerInfo',
  customerName: 'customerName',
  customerPhone: 'customerPhone',
  deliveryAddress: 'deliveryAddress',
  subtotal: 'subtotal',
  taxAmount: 'taxAmount',
  deliveryFee: 'deliveryFee',
  discount: 'discount',
  total: 'total',
  paymentStatus: 'paymentStatus',
  paymentMethod: 'paymentMethod',
  specialInstructions: 'specialInstructions',
  scheduledFor: 'scheduledFor',
  estimatedReadyAt: 'estimatedReadyAt',
  idempotencyKey: 'idempotencyKey',
  receivedAt: 'receivedAt',
  acceptedAt: 'acceptedAt',
  preparingAt: 'preparingAt',
  readyAt: 'readyAt',
  outForDeliveryAt: 'outForDeliveryAt',
  deliveredAt: 'deliveredAt',
  cancelledAt: 'cancelledAt',
  cancelReason: 'cancelReason',
  metadata: 'metadata',
  sourceMetadata: 'sourceMetadata',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.OrderItemScalarFieldEnum = {
  id: 'id',
  orderId: 'orderId',
  menuItemId: 'menuItemId',
  name: 'name',
  quantity: 'quantity',
  unitPrice: 'unitPrice',
  totalPrice: 'totalPrice',
  modifiers: 'modifiers',
  notes: 'notes',
  metadata: 'metadata',
  createdAt: 'createdAt'
};

exports.Prisma.OrderStatusHistoryScalarFieldEnum = {
  id: 'id',
  orderId: 'orderId',
  tenantId: 'tenantId',
  fromStatus: 'fromStatus',
  toStatus: 'toStatus',
  actorType: 'actorType',
  changedBy: 'changedBy',
  note: 'note',
  metadata: 'metadata',
  createdAt: 'createdAt'
};

exports.Prisma.WebhookEventScalarFieldEnum = {
  id: 'id',
  platform: 'platform',
  externalEventId: 'externalEventId',
  tenantId: 'tenantId',
  locationId: 'locationId',
  signature: 'signature',
  rawPayload: 'rawPayload',
  processedAt: 'processedAt',
  processingError: 'processingError',
  retryCount: 'retryCount',
  orderId: 'orderId',
  metadata: 'metadata',
  receivedAt: 'receivedAt'
};

exports.Prisma.KdsScreenScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  name: 'name',
  station: 'station',
  isActive: 'isActive',
  settings: 'settings',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.KdsTicketScalarFieldEnum = {
  id: 'id',
  kdsScreenId: 'kdsScreenId',
  orderId: 'orderId',
  bumpedAt: 'bumpedAt',
  recalledAt: 'recalledAt',
  createdAt: 'createdAt'
};

exports.Prisma.PrinterScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  name: 'name',
  type: 'type',
  connectionType: 'connectionType',
  station: 'station',
  ipAddress: 'ipAddress',
  port: 'port',
  isOnline: 'isOnline',
  deletedAt: 'deletedAt',
  supportsReceipts: 'supportsReceipts',
  supportsKitchen: 'supportsKitchen',
  supportsLabels: 'supportsLabels',
  supportsCut: 'supportsCut',
  supportsCashDrawer: 'supportsCashDrawer',
  settings: 'settings',
  metadata: 'metadata',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.PrintJobScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  printerId: 'printerId',
  orderId: 'orderId',
  type: 'type',
  status: 'status',
  payload: 'payload',
  attempts: 'attempts',
  maxRetries: 'maxRetries',
  error: 'error',
  retryMetadata: 'retryMetadata',
  printedAt: 'printedAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.SortOrder = {
  asc: 'asc',
  desc: 'desc'
};

exports.Prisma.JsonNullValueInput = {
  JsonNull: Prisma.JsonNull
};

exports.Prisma.NullableJsonNullValueInput = {
  DbNull: Prisma.DbNull,
  JsonNull: Prisma.JsonNull
};

exports.Prisma.QueryMode = {
  default: 'default',
  insensitive: 'insensitive'
};

exports.Prisma.JsonNullValueFilter = {
  DbNull: Prisma.DbNull,
  JsonNull: Prisma.JsonNull,
  AnyNull: Prisma.AnyNull
};

exports.Prisma.TenantOrderByRelevanceFieldEnum = {
  id: 'id',
  name: 'name',
  slug: 'slug'
};

exports.Prisma.NullsOrder = {
  first: 'first',
  last: 'last'
};

exports.Prisma.UserOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  email: 'email',
  password: 'password',
  firstName: 'firstName',
  lastName: 'lastName',
  avatarUrl: 'avatarUrl',
  permissions: 'permissions'
};

exports.Prisma.RefreshTokenOrderByRelevanceFieldEnum = {
  id: 'id',
  userId: 'userId',
  tokenHash: 'tokenHash',
  replacedByTokenId: 'replacedByTokenId',
  userAgent: 'userAgent',
  ipAddress: 'ipAddress'
};

exports.Prisma.OAuthAccountOrderByRelevanceFieldEnum = {
  id: 'id',
  userId: 'userId',
  providerAccountId: 'providerAccountId',
  accessToken: 'accessToken',
  refreshToken: 'refreshToken',
  tokenType: 'tokenType',
  scope: 'scope',
  idToken: 'idToken'
};

exports.Prisma.ApiKeyOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  name: 'name',
  keyHash: 'keyHash',
  prefix: 'prefix',
  scopes: 'scopes'
};

exports.Prisma.AuditLogOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  userId: 'userId',
  event: 'event',
  resource: 'resource',
  resourceId: 'resourceId',
  ipAddress: 'ipAddress',
  userAgent: 'userAgent'
};

exports.Prisma.BrandOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  name: 'name',
  slug: 'slug',
  logoUrl: 'logoUrl'
};

exports.Prisma.LocationOrderByRelevanceFieldEnum = {
  id: 'id',
  brandId: 'brandId',
  name: 'name',
  externalRef: 'externalRef',
  phone: 'phone',
  timezone: 'timezone'
};

exports.Prisma.IntegrationOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  webhookUrl: 'webhookUrl',
  lastError: 'lastError'
};

exports.Prisma.MenuOrderByRelevanceFieldEnum = {
  id: 'id',
  brandId: 'brandId',
  name: 'name'
};

exports.Prisma.MenuCategoryOrderByRelevanceFieldEnum = {
  id: 'id',
  menuId: 'menuId',
  name: 'name'
};

exports.Prisma.MenuItemOrderByRelevanceFieldEnum = {
  id: 'id',
  brandId: 'brandId',
  name: 'name',
  description: 'description',
  imageUrl: 'imageUrl',
  sku: 'sku',
  allergens: 'allergens'
};

exports.Prisma.MenuItemOnCategoryOrderByRelevanceFieldEnum = {
  categoryId: 'categoryId',
  itemId: 'itemId'
};

exports.Prisma.OrderOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  externalId: 'externalId',
  displayId: 'displayId',
  customerName: 'customerName',
  customerPhone: 'customerPhone',
  paymentMethod: 'paymentMethod',
  specialInstructions: 'specialInstructions',
  idempotencyKey: 'idempotencyKey',
  cancelReason: 'cancelReason'
};

exports.Prisma.OrderItemOrderByRelevanceFieldEnum = {
  id: 'id',
  orderId: 'orderId',
  menuItemId: 'menuItemId',
  name: 'name',
  notes: 'notes'
};

exports.Prisma.OrderStatusHistoryOrderByRelevanceFieldEnum = {
  id: 'id',
  orderId: 'orderId',
  tenantId: 'tenantId',
  changedBy: 'changedBy',
  note: 'note'
};

exports.Prisma.WebhookEventOrderByRelevanceFieldEnum = {
  id: 'id',
  platform: 'platform',
  externalEventId: 'externalEventId',
  tenantId: 'tenantId',
  locationId: 'locationId',
  signature: 'signature',
  processingError: 'processingError',
  orderId: 'orderId'
};

exports.Prisma.KdsScreenOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  name: 'name',
  station: 'station'
};

exports.Prisma.KdsTicketOrderByRelevanceFieldEnum = {
  id: 'id',
  kdsScreenId: 'kdsScreenId',
  orderId: 'orderId'
};

exports.Prisma.PrinterOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  name: 'name',
  ipAddress: 'ipAddress'
};

exports.Prisma.PrintJobOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  printerId: 'printerId',
  orderId: 'orderId',
  error: 'error'
};
exports.TenantPlan = exports.$Enums.TenantPlan = {
  STARTER: 'STARTER',
  PROFESSIONAL: 'PROFESSIONAL',
  ENTERPRISE: 'ENTERPRISE'
};

exports.TenantStatus = exports.$Enums.TenantStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  CANCELLED: 'CANCELLED'
};

exports.UserRole = exports.$Enums.UserRole = {
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  TENANT_OWNER: 'TENANT_OWNER',
  MANAGER: 'MANAGER',
  CASHIER: 'CASHIER',
  KITCHEN_STAFF: 'KITCHEN_STAFF',
  DRIVER: 'DRIVER',
  VIEWER: 'VIEWER'
};

exports.OAuthProvider = exports.$Enums.OAuthProvider = {
  GOOGLE: 'GOOGLE',
  APPLE: 'APPLE',
  MICROSOFT: 'MICROSOFT',
  UBER_EATS: 'UBER_EATS',
  DELIVEROO: 'DELIVEROO',
  JUST_EAT: 'JUST_EAT'
};

exports.IntegrationPlatform = exports.$Enums.IntegrationPlatform = {
  UBER_EATS: 'UBER_EATS',
  DELIVEROO: 'DELIVEROO',
  JUST_EAT: 'JUST_EAT',
  HUBRISE: 'HUBRISE',
  DIRECT: 'DIRECT'
};

exports.IntegrationStatus = exports.$Enums.IntegrationStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  ERROR: 'ERROR',
  PENDING_SETUP: 'PENDING_SETUP'
};

exports.OrderPlatform = exports.$Enums.OrderPlatform = {
  UBER_EATS: 'UBER_EATS',
  DELIVEROO: 'DELIVEROO',
  JUST_EAT: 'JUST_EAT',
  HUBRISE: 'HUBRISE',
  DIRECT: 'DIRECT',
  POS: 'POS',
  ONLINE: 'ONLINE'
};

exports.OrderSource = exports.$Enums.OrderSource = {
  ONLINE: 'ONLINE',
  POS: 'POS',
  UBER_EATS: 'UBER_EATS',
  DELIVEROO: 'DELIVEROO',
  JUST_EAT: 'JUST_EAT',
  HUBRISE: 'HUBRISE',
  DIRECT: 'DIRECT'
};

exports.IntegrationSource = exports.$Enums.IntegrationSource = {
  DIRECT: 'DIRECT',
  HUBRISE: 'HUBRISE'
};

exports.OrderStatus = exports.$Enums.OrderStatus = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  PREPARING: 'PREPARING',
  READY: 'READY',
  DISPATCHED: 'DISPATCHED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED'
};

exports.FulfillmentType = exports.$Enums.FulfillmentType = {
  PICKUP: 'PICKUP',
  DELIVERY: 'DELIVERY',
  DINE_IN: 'DINE_IN',
  MERCHANT_DELIVERY: 'MERCHANT_DELIVERY',
  PLATFORM_COURIER: 'PLATFORM_COURIER'
};

exports.PaymentStatus = exports.$Enums.PaymentStatus = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  REFUNDED: 'REFUNDED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
  FAILED: 'FAILED'
};

exports.OrderStatusActorType = exports.$Enums.OrderStatusActorType = {
  STAFF: 'STAFF',
  SYSTEM: 'SYSTEM',
  WEBHOOK: 'WEBHOOK',
  API: 'API',
  KIOSK: 'KIOSK'
};

exports.PrinterType = exports.$Enums.PrinterType = {
  RECEIPT: 'RECEIPT',
  KITCHEN: 'KITCHEN',
  LABEL: 'LABEL',
  MULTI: 'MULTI'
};

exports.PrinterConnectionType = exports.$Enums.PrinterConnectionType = {
  USB: 'USB',
  LAN: 'LAN',
  BLUETOOTH: 'BLUETOOTH',
  EPSON_EPOS: 'EPSON_EPOS',
  STAR: 'STAR',
  CLOUD: 'CLOUD'
};

exports.PrinterStation = exports.$Enums.PrinterStation = {
  KITCHEN: 'KITCHEN',
  FRONT_COUNTER: 'FRONT_COUNTER',
  BAR: 'BAR',
  LABELS: 'LABELS',
  DISPATCH: 'DISPATCH'
};

exports.PrintJobType = exports.$Enums.PrintJobType = {
  RECEIPT: 'RECEIPT',
  KITCHEN_TICKET: 'KITCHEN_TICKET',
  LABEL: 'LABEL',
  DRIVER_RECEIPT: 'DRIVER_RECEIPT',
  CANCEL_TICKET: 'CANCEL_TICKET',
  REPRINT: 'REPRINT',
  EOD_REPORT: 'EOD_REPORT'
};

exports.PrintJobStatus = exports.$Enums.PrintJobStatus = {
  QUEUED: 'QUEUED',
  PRINTING: 'PRINTING',
  PRINTED: 'PRINTED',
  FAILED: 'FAILED',
  RETRYING: 'RETRYING'
};

exports.Prisma.ModelName = {
  Tenant: 'Tenant',
  User: 'User',
  RefreshToken: 'RefreshToken',
  OAuthAccount: 'OAuthAccount',
  ApiKey: 'ApiKey',
  AuditLog: 'AuditLog',
  Brand: 'Brand',
  Location: 'Location',
  Integration: 'Integration',
  Menu: 'Menu',
  MenuCategory: 'MenuCategory',
  MenuItem: 'MenuItem',
  MenuItemOnCategory: 'MenuItemOnCategory',
  Order: 'Order',
  OrderItem: 'OrderItem',
  OrderStatusHistory: 'OrderStatusHistory',
  WebhookEvent: 'WebhookEvent',
  KdsScreen: 'KdsScreen',
  KdsTicket: 'KdsTicket',
  Printer: 'Printer',
  PrintJob: 'PrintJob'
};

/**
 * This is a stub Prisma Client that will error at runtime if called.
 */
class PrismaClient {
  constructor() {
    return new Proxy(this, {
      get(target, prop) {
        let message
        const runtime = getRuntime()
        if (runtime.isEdge) {
          message = `PrismaClient is not configured to run in ${runtime.prettyName}. In order to run Prisma Client on edge runtime, either:
- Use Prisma Accelerate: https://pris.ly/d/accelerate
- Use Driver Adapters: https://pris.ly/d/driver-adapters
`;
        } else {
          message = 'PrismaClient is unable to run in this browser environment, or has been bundled for the browser (running in `' + runtime.prettyName + '`).'
        }
        
        message += `
If this is unexpected, please open an issue: https://pris.ly/prisma-prisma-bug-report`

        throw new Error(message)
      }
    })
  }
}

exports.PrismaClient = PrismaClient

Object.assign(exports, Prisma)
