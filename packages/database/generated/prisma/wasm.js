
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
  description: 'description',
  cuisine: 'cuisine',
  isSuspended: 'isSuspended',
  primaryLocationId: 'primaryLocationId',
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
  addressLine1: 'addressLine1',
  addressLine2: 'addressLine2',
  city: 'city',
  postcode: 'postcode',
  country: 'country',
  about: 'about',
  logoUrl: 'logoUrl',
  customDomain: 'customDomain',
  customDomainStatus: 'customDomainStatus',
  onlineOrderingSlug: 'onlineOrderingSlug',
  stripeConnectedAccountId: 'stripeConnectedAccountId',
  applicationFeeFixedAmount: 'applicationFeeFixedAmount',
  applicationFeePercentage: 'applicationFeePercentage',
  applicationFeeMode: 'applicationFeeMode',
  status: 'status',
  busyModeJson: 'busyModeJson',
  shopCode: 'shopCode',
  printToken: 'printToken',
  slug: 'slug',
  openingHours: 'openingHours',
  deliveryConfig: 'deliveryConfig',
  onboardingStep: 'onboardingStep',
  goLiveStatus: 'goLiveStatus',
  lastTestOrderAt: 'lastTestOrderAt',
  lastTestPrintAt: 'lastTestPrintAt',
  isOpen: 'isOpen',
  isPaused: 'isPaused',
  pauseUntil: 'pauseUntil',
  busyMode: 'busyMode',
  currentPrepTime: 'currentPrepTime',
  throttleLimit: 'throttleLimit',
  storeStatusNote: 'storeStatusNote',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.BrandPlatformConnectionScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  brandId: 'brandId',
  locationId: 'locationId',
  platform: 'platform',
  status: 'status',
  externalStoreId: 'externalStoreId',
  externalBrandId: 'externalBrandId',
  integrationId: 'integrationId',
  lastSyncAt: 'lastSyncAt',
  lastWebhookAt: 'lastWebhookAt',
  lastError: 'lastError',
  metadata: 'metadata',
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
  locationId: 'locationId',
  name: 'name',
  description: 'description',
  menuType: 'menuType',
  bannerImage: 'bannerImage',
  heroImage: 'heroImage',
  logoImage: 'logoImage',
  status: 'status',
  isActive: 'isActive',
  deletedAt: 'deletedAt',
  importStatus: 'importStatus',
  importLock: 'importLock',
  importedAt: 'importedAt',
  syncVersion: 'syncVersion',
  rawImportPayload: 'rawImportPayload',
  menuData: 'menuData',
  productModifierGroupLinks: 'productModifierGroupLinks',
  modifierGroupModifierLinks: 'modifierGroupModifierLinks',
  platformSource: 'platformSource',
  externalId: 'externalId',
  externalParentId: 'externalParentId',
  lastSyncedAt: 'lastSyncedAt',
  syncStatus: 'syncStatus',
  syncHash: 'syncHash',
  publishedTo: 'publishedTo',
  lastPublishedAt: 'lastPublishedAt',
  autoScheduleEnabled: 'autoScheduleEnabled',
  autoSchedule: 'autoSchedule',
  metadata: 'metadata',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.MenuCategoryScalarFieldEnum = {
  id: 'id',
  menuId: 'menuId',
  name: 'name',
  description: 'description',
  imageUrl: 'imageUrl',
  sortOrder: 'sortOrder',
  isVisible: 'isVisible',
  menuIds: 'menuIds',
  available: 'available',
  visibleToCustomers: 'visibleToCustomers',
  platformSource: 'platformSource',
  externalId: 'externalId',
  externalParentId: 'externalParentId',
  lastSyncedAt: 'lastSyncedAt',
  syncStatus: 'syncStatus',
  syncHash: 'syncHash',
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
  plu: 'plu',
  isAvailable: 'isAvailable',
  visibleToCustomers: 'visibleToCustomers',
  outOfStock: 'outOfStock',
  availableRestoreAt: 'availableRestoreAt',
  allergens: 'allergens',
  dietaryTags: 'dietaryTags',
  dietary: 'dietary',
  calories: 'calories',
  prepTime: 'prepTime',
  metadata: 'metadata',
  hasMultipleSkus: 'hasMultipleSkus',
  productSkus: 'productSkus',
  deliveryTax: 'deliveryTax',
  takeawayTax: 'takeawayTax',
  eatInTax: 'eatInTax',
  menuIds: 'menuIds',
  brandIds: 'brandIds',
  sortOrder: 'sortOrder',
  isInventoryTracked: 'isInventoryTracked',
  inventoryCount: 'inventoryCount',
  platformPricingOverrides: 'platformPricingOverrides',
  platformSource: 'platformSource',
  externalId: 'externalId',
  externalParentId: 'externalParentId',
  lastSyncedAt: 'lastSyncedAt',
  syncStatus: 'syncStatus',
  syncHash: 'syncHash',
  rawModifierGroupIds: 'rawModifierGroupIds',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.MenuItemOnCategoryScalarFieldEnum = {
  categoryId: 'categoryId',
  itemId: 'itemId',
  sortOrder: 'sortOrder',
  priceOverride: 'priceOverride',
  isVisible: 'isVisible'
};

exports.Prisma.ModifierGroupScalarFieldEnum = {
  id: 'id',
  brandId: 'brandId',
  name: 'name',
  description: 'description',
  plu: 'plu',
  minSelections: 'minSelections',
  maxSelections: 'maxSelections',
  isRequired: 'isRequired',
  sortOrder: 'sortOrder',
  selectionType: 'selectionType',
  allowDuplicateSelections: 'allowDuplicateSelections',
  visibleToCustomers: 'visibleToCustomers',
  menuIds: 'menuIds',
  platformSource: 'platformSource',
  externalId: 'externalId',
  externalParentId: 'externalParentId',
  lastSyncedAt: 'lastSyncedAt',
  syncStatus: 'syncStatus',
  syncHash: 'syncHash',
  rawModifierIds: 'rawModifierIds',
  metadata: 'metadata',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.ModifierOptionScalarFieldEnum = {
  id: 'id',
  groupId: 'groupId',
  modifierGroupIds: 'modifierGroupIds',
  name: 'name',
  description: 'description',
  priceAdjustment: 'priceAdjustment',
  plu: 'plu',
  pricesBySize: 'pricesBySize',
  skuPlus: 'skuPlus',
  imageUrl: 'imageUrl',
  allergens: 'allergens',
  isDefault: 'isDefault',
  isAvailable: 'isAvailable',
  visibleToCustomers: 'visibleToCustomers',
  availableRestoreAt: 'availableRestoreAt',
  sortOrder: 'sortOrder',
  menuIds: 'menuIds',
  deliveryTax: 'deliveryTax',
  takeawayTax: 'takeawayTax',
  eatInTax: 'eatInTax',
  platformSource: 'platformSource',
  externalId: 'externalId',
  externalParentId: 'externalParentId',
  lastSyncedAt: 'lastSyncedAt',
  syncStatus: 'syncStatus',
  syncHash: 'syncHash',
  nestedGroupId: 'nestedGroupId',
  metadata: 'metadata',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.ModifierGroupOnItemScalarFieldEnum = {
  itemId: 'itemId',
  groupId: 'groupId',
  sortOrder: 'sortOrder'
};

exports.Prisma.MenuItemVariantScalarFieldEnum = {
  id: 'id',
  itemId: 'itemId',
  name: 'name',
  sku: 'sku',
  price: 'price',
  sortOrder: 'sortOrder',
  isAvailable: 'isAvailable',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.MealDealScalarFieldEnum = {
  id: 'id',
  brandId: 'brandId',
  locationIds: 'locationIds',
  name: 'name',
  description: 'description',
  imageUrl: 'imageUrl',
  plu: 'plu',
  price: 'price',
  sections: 'sections',
  deliveryTax: 'deliveryTax',
  takeawayTax: 'takeawayTax',
  eatInTax: 'eatInTax',
  platformPricingOverrides: 'platformPricingOverrides',
  isAvailable: 'isAvailable',
  visibleToCustomers: 'visibleToCustomers',
  sortOrder: 'sortOrder',
  platformSource: 'platformSource',
  externalId: 'externalId',
  lastSyncedAt: 'lastSyncedAt',
  syncStatus: 'syncStatus',
  syncHash: 'syncHash',
  metadata: 'metadata',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.UpsellGroupScalarFieldEnum = {
  id: 'id',
  brandId: 'brandId',
  name: 'name',
  description: 'description',
  triggerProductIds: 'triggerProductIds',
  triggerCategoryIds: 'triggerCategoryIds',
  suggestedProductIds: 'suggestedProductIds',
  sortOrder: 'sortOrder',
  platformVisibility: 'platformVisibility',
  isActive: 'isActive',
  metadata: 'metadata',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.MenuVersionScalarFieldEnum = {
  id: 'id',
  menuId: 'menuId',
  version: 'version',
  snapshot: 'snapshot',
  label: 'label',
  createdBy: 'createdBy',
  createdAt: 'createdAt'
};

exports.Prisma.CustomerScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  email: 'email',
  phone: 'phone',
  firstName: 'firstName',
  lastName: 'lastName',
  marketingConsent: 'marketingConsent',
  isActive: 'isActive',
  tags: 'tags',
  metadata: 'metadata',
  supabaseUserId: 'supabaseUserId',
  lastSignInAt: 'lastSignInAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.DirectOrderingConfigScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  deliveryPrepMinutes: 'deliveryPrepMinutes',
  collectionPrepMinutes: 'collectionPrepMinutes',
  acceptsCash: 'acceptsCash',
  acceptsCard: 'acceptsCard',
  acceptsDelivery: 'acceptsDelivery',
  acceptsCollection: 'acceptsCollection',
  scheduleMaxDaysAhead: 'scheduleMaxDaysAhead',
  scheduleSlotMinutes: 'scheduleSlotMinutes',
  minOrderForDelivery: 'minOrderForDelivery',
  heroImageUrl: 'heroImageUrl',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.CustomerAddressScalarFieldEnum = {
  id: 'id',
  customerId: 'customerId',
  label: 'label',
  line1: 'line1',
  line2: 'line2',
  city: 'city',
  postcode: 'postcode',
  country: 'country',
  isDefault: 'isDefault',
  coordinates: 'coordinates',
  createdAt: 'createdAt'
};

exports.Prisma.LoyaltyAccountScalarFieldEnum = {
  id: 'id',
  customerId: 'customerId',
  tenantId: 'tenantId',
  points: 'points',
  tier: 'tier',
  totalSpend: 'totalSpend',
  totalOrders: 'totalOrders',
  metadata: 'metadata',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.PromoCodeScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  code: 'code',
  description: 'description',
  type: 'type',
  value: 'value',
  minOrderValue: 'minOrderValue',
  maxUses: 'maxUses',
  usedCount: 'usedCount',
  startAt: 'startAt',
  expiresAt: 'expiresAt',
  isActive: 'isActive',
  locationIds: 'locationIds',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.DeliveryZoneScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  postcodePrefix: 'postcodePrefix',
  fee: 'fee',
  minOrderValue: 'minOrderValue',
  isActive: 'isActive',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.LocationPaymentConfigScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  provider: 'provider',
  cashEnabled: 'cashEnabled',
  cardTerminalEnabled: 'cardTerminalEnabled',
  onlinePaymentEnabled: 'onlinePaymentEnabled',
  config: 'config',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.OrderScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  customerId: 'customerId',
  brandId: 'brandId',
  externalId: 'externalId',
  platform: 'platform',
  displayId: 'displayId',
  orderNumber: 'orderNumber',
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
  serviceCharge: 'serviceCharge',
  deliveryFee: 'deliveryFee',
  discount: 'discount',
  total: 'total',
  isSandbox: 'isSandbox',
  paymentStatus: 'paymentStatus',
  paymentMethod: 'paymentMethod',
  promoCode: 'promoCode',
  promoDiscount: 'promoDiscount',
  specialInstructions: 'specialInstructions',
  scheduledFor: 'scheduledFor',
  scheduledAt: 'scheduledAt',
  estimatedReadyAt: 'estimatedReadyAt',
  idempotencyKey: 'idempotencyKey',
  collectionCode: 'collectionCode',
  preparationMinutes: 'preparationMinutes',
  failureReason: 'failureReason',
  addressLine1: 'addressLine1',
  addressLine2: 'addressLine2',
  city: 'city',
  postcode: 'postcode',
  callerId: 'callerId',
  discountType: 'discountType',
  paymentProvider: 'paymentProvider',
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

exports.Prisma.OrderNumberSequenceScalarFieldEnum = {
  tenantId: 'tenantId',
  nextValue: 'nextValue',
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
  isActive: 'isActive',
  deletedAt: 'deletedAt',
  failoverPrinterId: 'failoverPrinterId',
  supportsReceipts: 'supportsReceipts',
  supportsKitchen: 'supportsKitchen',
  supportsLabels: 'supportsLabels',
  supportsCut: 'supportsCut',
  supportsCashDrawer: 'supportsCashDrawer',
  autoPrintRules: 'autoPrintRules',
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

exports.Prisma.PrintTemplateScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  name: 'name',
  type: 'type',
  template: 'template',
  isDefault: 'isDefault',
  isActive: 'isActive',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.DriverScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  userId: 'userId',
  firstName: 'firstName',
  lastName: 'lastName',
  phone: 'phone',
  email: 'email',
  isActive: 'isActive',
  vehicleType: 'vehicleType',
  metadata: 'metadata',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.DriverAssignmentScalarFieldEnum = {
  id: 'id',
  orderId: 'orderId',
  driverId: 'driverId',
  status: 'status',
  assignedAt: 'assignedAt',
  acceptedAt: 'acceptedAt',
  pickedUpAt: 'pickedUpAt',
  deliveredAt: 'deliveredAt'
};

exports.Prisma.DeliveryTrackingScalarFieldEnum = {
  id: 'id',
  assignmentId: 'assignmentId',
  lat: 'lat',
  lng: 'lng',
  accuracy: 'accuracy',
  heading: 'heading',
  speed: 'speed',
  event: 'event',
  recordedAt: 'recordedAt'
};

exports.Prisma.StripeConnectAccountScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  stripeAccountId: 'stripeAccountId',
  accountType: 'accountType',
  chargesEnabled: 'chargesEnabled',
  payoutsEnabled: 'payoutsEnabled',
  defaultCurrency: 'defaultCurrency',
  country: 'country',
  onboardingComplete: 'onboardingComplete',
  metadata: 'metadata',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.PaymentScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  orderId: 'orderId',
  stripeConnectAccountId: 'stripeConnectAccountId',
  stripePaymentIntentId: 'stripePaymentIntentId',
  stripeChargeId: 'stripeChargeId',
  amount: 'amount',
  currency: 'currency',
  status: 'status',
  method: 'method',
  tipAmount: 'tipAmount',
  platformFee: 'platformFee',
  processingFee: 'processingFee',
  netAmount: 'netAmount',
  metadata: 'metadata',
  createdAt: 'createdAt'
};

exports.Prisma.PaymentMethodScalarFieldEnum = {
  id: 'id',
  customerId: 'customerId',
  stripePaymentMethodId: 'stripePaymentMethodId',
  type: 'type',
  last4: 'last4',
  brand: 'brand',
  expMonth: 'expMonth',
  expYear: 'expYear',
  isDefault: 'isDefault',
  createdAt: 'createdAt'
};

exports.Prisma.RefundScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  paymentId: 'paymentId',
  stripeRefundId: 'stripeRefundId',
  amount: 'amount',
  reason: 'reason',
  status: 'status',
  isPartial: 'isPartial',
  processedBy: 'processedBy',
  note: 'note',
  createdAt: 'createdAt'
};

exports.Prisma.LedgerEntryScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  paymentId: 'paymentId',
  refundId: 'refundId',
  type: 'type',
  amount: 'amount',
  currency: 'currency',
  description: 'description',
  reference: 'reference',
  metadata: 'metadata',
  createdAt: 'createdAt'
};

exports.Prisma.PayoutScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  connectAccountId: 'connectAccountId',
  stripePayoutId: 'stripePayoutId',
  amount: 'amount',
  currency: 'currency',
  status: 'status',
  arrivalDate: 'arrivalDate',
  description: 'description',
  metadata: 'metadata',
  createdAt: 'createdAt'
};

exports.Prisma.SupplierScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  name: 'name',
  email: 'email',
  phone: 'phone',
  address: 'address',
  isActive: 'isActive',
  metadata: 'metadata',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.IngredientScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  supplierId: 'supplierId',
  name: 'name',
  unit: 'unit',
  costPerUnit: 'costPerUnit',
  lowStockAlert: 'lowStockAlert',
  isActive: 'isActive',
  metadata: 'metadata',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.StockLevelScalarFieldEnum = {
  id: 'id',
  ingredientId: 'ingredientId',
  locationId: 'locationId',
  quantity: 'quantity',
  updatedAt: 'updatedAt'
};

exports.Prisma.RecipeScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  menuItemId: 'menuItemId',
  yields: 'yields',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.RecipeIngredientScalarFieldEnum = {
  id: 'id',
  recipeId: 'recipeId',
  ingredientId: 'ingredientId',
  quantity: 'quantity'
};

exports.Prisma.StockMovementScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  ingredientId: 'ingredientId',
  type: 'type',
  quantity: 'quantity',
  reason: 'reason',
  orderId: 'orderId',
  purchaseOrderId: 'purchaseOrderId',
  recordedBy: 'recordedBy',
  metadata: 'metadata',
  createdAt: 'createdAt'
};

exports.Prisma.PurchaseOrderScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  supplierId: 'supplierId',
  status: 'status',
  orderedAt: 'orderedAt',
  expectedAt: 'expectedAt',
  receivedAt: 'receivedAt',
  totalCost: 'totalCost',
  notes: 'notes',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.PurchaseOrderLineScalarFieldEnum = {
  id: 'id',
  purchaseOrderId: 'purchaseOrderId',
  ingredientId: 'ingredientId',
  quantity: 'quantity',
  unitCost: 'unitCost',
  totalCost: 'totalCost',
  receivedQty: 'receivedQty'
};

exports.Prisma.DeviceTokenScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  tenantId: 'tenantId',
  token: 'token',
  platform: 'platform',
  deviceId: 'deviceId',
  appId: 'appId',
  isActive: 'isActive',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.NotificationLogScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  userId: 'userId',
  type: 'type',
  channel: 'channel',
  title: 'title',
  body: 'body',
  data: 'data',
  status: 'status',
  errorMsg: 'errorMsg',
  createdAt: 'createdAt'
};

exports.Prisma.TenantBrandingScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  logoUrl: 'logoUrl',
  faviconUrl: 'faviconUrl',
  primaryColor: 'primaryColor',
  secondaryColor: 'secondaryColor',
  accentColor: 'accentColor',
  fontFamily: 'fontFamily',
  customCss: 'customCss',
  appName: 'appName',
  metaTitle: 'metaTitle',
  metaDescription: 'metaDescription',
  emailFromName: 'emailFromName',
  emailFromAddr: 'emailFromAddr',
  emailFooterHtml: 'emailFooterHtml',
  senderSmsName: 'senderSmsName',
  socialLinks: 'socialLinks',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.CustomDomainScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  brandingId: 'brandingId',
  domain: 'domain',
  status: 'status',
  verifiedAt: 'verifiedAt',
  sslAt: 'sslAt',
  txtRecord: 'txtRecord',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.SubscriptionPlanScalarFieldEnum = {
  id: 'id',
  name: 'name',
  displayName: 'displayName',
  stripePriceId: 'stripePriceId',
  pricePerMonth: 'pricePerMonth',
  pricePerLocation: 'pricePerLocation',
  maxLocations: 'maxLocations',
  maxUsers: 'maxUsers',
  features: 'features',
  isActive: 'isActive',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.TenantSubscriptionScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  planId: 'planId',
  stripeSubId: 'stripeSubId',
  stripeCustomerId: 'stripeCustomerId',
  status: 'status',
  currentPeriodStart: 'currentPeriodStart',
  currentPeriodEnd: 'currentPeriodEnd',
  cancelAtPeriodEnd: 'cancelAtPeriodEnd',
  trialEndsAt: 'trialEndsAt',
  locationCount: 'locationCount',
  metadata: 'metadata',
  billingEmail: 'billingEmail',
  paymentMethodStatus: 'paymentMethodStatus',
  lastInvoiceStatus: 'lastInvoiceStatus',
  gracePeriodEndsAt: 'gracePeriodEndsAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.InvoiceScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  subscriptionId: 'subscriptionId',
  stripeInvoiceId: 'stripeInvoiceId',
  number: 'number',
  status: 'status',
  amountDue: 'amountDue',
  amountPaid: 'amountPaid',
  currency: 'currency',
  dueDate: 'dueDate',
  paidAt: 'paidAt',
  pdfUrl: 'pdfUrl',
  createdAt: 'createdAt'
};

exports.Prisma.InvoiceLineItemScalarFieldEnum = {
  id: 'id',
  invoiceId: 'invoiceId',
  description: 'description',
  quantity: 'quantity',
  unitAmount: 'unitAmount',
  amount: 'amount'
};

exports.Prisma.UsageRecordScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  subscriptionId: 'subscriptionId',
  locationId: 'locationId',
  billingMonth: 'billingMonth',
  orderCount: 'orderCount',
  printJobCount: 'printJobCount',
  activeProviders: 'activeProviders',
  reportedToStripe: 'reportedToStripe',
  reportedAt: 'reportedAt',
  metadata: 'metadata',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.StripeWebhookEventScalarFieldEnum = {
  id: 'id',
  stripeEventId: 'stripeEventId',
  type: 'type',
  processedAt: 'processedAt',
  error: 'error',
  payload: 'payload',
  receivedAt: 'receivedAt'
};

exports.Prisma.MfaConfigScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  secret: 'secret',
  isEnabled: 'isEnabled',
  backupCodes: 'backupCodes',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.IpAllowlistScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  cidr: 'cidr',
  label: 'label',
  isActive: 'isActive',
  createdAt: 'createdAt'
};

exports.Prisma.DeviceSessionScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  tenantId: 'tenantId',
  sessionToken: 'sessionToken',
  deviceName: 'deviceName',
  deviceType: 'deviceType',
  appVersion: 'appVersion',
  ipAddress: 'ipAddress',
  userAgent: 'userAgent',
  lastSeenAt: 'lastSeenAt',
  expiresAt: 'expiresAt',
  revokedAt: 'revokedAt',
  createdAt: 'createdAt'
};

exports.Prisma.DailySalesSnapshotScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  date: 'date',
  platform: 'platform',
  totalRevenue: 'totalRevenue',
  totalOrders: 'totalOrders',
  avgOrderValue: 'avgOrderValue',
  newCustomers: 'newCustomers',
  repeatCustomers: 'repeatCustomers',
  cancelledOrders: 'cancelledOrders',
  avgPrepTimeMin: 'avgPrepTimeMin',
  metadata: 'metadata'
};

exports.Prisma.ItemPerformanceSnapshotScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  menuItemId: 'menuItemId',
  locationId: 'locationId',
  date: 'date',
  totalSold: 'totalSold',
  totalRevenue: 'totalRevenue',
  cancelledQty: 'cancelledQty'
};

exports.Prisma.ProviderDefinitionScalarFieldEnum = {
  id: 'id',
  key: 'key',
  name: 'name',
  category: 'category',
  capabilities: 'capabilities',
  webhookPath: 'webhookPath',
  logoUrl: 'logoUrl',
  docsUrl: 'docsUrl',
  isEnabled: 'isEnabled',
  isBeta: 'isBeta',
  metadata: 'metadata',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.WebhookRouteScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  providerKey: 'providerKey',
  pathPattern: 'pathPattern',
  isActive: 'isActive',
  metadata: 'metadata',
  createdAt: 'createdAt'
};

exports.Prisma.MobileSessionScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  tenantId: 'tenantId',
  appId: 'appId',
  deviceId: 'deviceId',
  deviceModel: 'deviceModel',
  osVersion: 'osVersion',
  appVersion: 'appVersion',
  fcmToken: 'fcmToken',
  isActive: 'isActive',
  lastSyncAt: 'lastSyncAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.WebPushSubscriptionScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  tenantId: 'tenantId',
  endpoint: 'endpoint',
  p256dh: 'p256dh',
  auth: 'auth',
  isActive: 'isActive',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.OutboxEventScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  aggregateType: 'aggregateType',
  aggregateId: 'aggregateId',
  eventType: 'eventType',
  payload: 'payload',
  status: 'status',
  attempts: 'attempts',
  maxAttempts: 'maxAttempts',
  nextAttemptAt: 'nextAttemptAt',
  processedAt: 'processedAt',
  lastError: 'lastError',
  idempotencyKey: 'idempotencyKey',
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
  logoUrl: 'logoUrl',
  description: 'description',
  cuisine: 'cuisine',
  primaryLocationId: 'primaryLocationId'
};

exports.Prisma.LocationOrderByRelevanceFieldEnum = {
  id: 'id',
  brandId: 'brandId',
  name: 'name',
  externalRef: 'externalRef',
  phone: 'phone',
  timezone: 'timezone',
  addressLine1: 'addressLine1',
  addressLine2: 'addressLine2',
  city: 'city',
  postcode: 'postcode',
  country: 'country',
  about: 'about',
  logoUrl: 'logoUrl',
  customDomain: 'customDomain',
  customDomainStatus: 'customDomainStatus',
  onlineOrderingSlug: 'onlineOrderingSlug',
  stripeConnectedAccountId: 'stripeConnectedAccountId',
  applicationFeeMode: 'applicationFeeMode',
  status: 'status',
  shopCode: 'shopCode',
  printToken: 'printToken',
  slug: 'slug',
  storeStatusNote: 'storeStatusNote'
};

exports.Prisma.BrandPlatformConnectionOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  brandId: 'brandId',
  locationId: 'locationId',
  platform: 'platform',
  status: 'status',
  externalStoreId: 'externalStoreId',
  externalBrandId: 'externalBrandId',
  integrationId: 'integrationId',
  lastError: 'lastError'
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
  locationId: 'locationId',
  name: 'name',
  description: 'description',
  bannerImage: 'bannerImage',
  heroImage: 'heroImage',
  logoImage: 'logoImage',
  platformSource: 'platformSource',
  externalId: 'externalId',
  externalParentId: 'externalParentId',
  syncStatus: 'syncStatus',
  syncHash: 'syncHash',
  publishedTo: 'publishedTo'
};

exports.Prisma.MenuCategoryOrderByRelevanceFieldEnum = {
  id: 'id',
  menuId: 'menuId',
  name: 'name',
  description: 'description',
  imageUrl: 'imageUrl',
  menuIds: 'menuIds',
  platformSource: 'platformSource',
  externalId: 'externalId',
  externalParentId: 'externalParentId',
  syncStatus: 'syncStatus',
  syncHash: 'syncHash'
};

exports.Prisma.MenuItemOrderByRelevanceFieldEnum = {
  id: 'id',
  brandId: 'brandId',
  name: 'name',
  description: 'description',
  imageUrl: 'imageUrl',
  sku: 'sku',
  plu: 'plu',
  allergens: 'allergens',
  dietaryTags: 'dietaryTags',
  menuIds: 'menuIds',
  brandIds: 'brandIds',
  platformSource: 'platformSource',
  externalId: 'externalId',
  externalParentId: 'externalParentId',
  syncStatus: 'syncStatus',
  syncHash: 'syncHash'
};

exports.Prisma.MenuItemOnCategoryOrderByRelevanceFieldEnum = {
  categoryId: 'categoryId',
  itemId: 'itemId'
};

exports.Prisma.ModifierGroupOrderByRelevanceFieldEnum = {
  id: 'id',
  brandId: 'brandId',
  name: 'name',
  description: 'description',
  plu: 'plu',
  menuIds: 'menuIds',
  platformSource: 'platformSource',
  externalId: 'externalId',
  externalParentId: 'externalParentId',
  syncStatus: 'syncStatus',
  syncHash: 'syncHash'
};

exports.Prisma.ModifierOptionOrderByRelevanceFieldEnum = {
  id: 'id',
  groupId: 'groupId',
  modifierGroupIds: 'modifierGroupIds',
  name: 'name',
  description: 'description',
  plu: 'plu',
  imageUrl: 'imageUrl',
  allergens: 'allergens',
  menuIds: 'menuIds',
  platformSource: 'platformSource',
  externalId: 'externalId',
  externalParentId: 'externalParentId',
  syncStatus: 'syncStatus',
  syncHash: 'syncHash',
  nestedGroupId: 'nestedGroupId'
};

exports.Prisma.ModifierGroupOnItemOrderByRelevanceFieldEnum = {
  itemId: 'itemId',
  groupId: 'groupId'
};

exports.Prisma.MenuItemVariantOrderByRelevanceFieldEnum = {
  id: 'id',
  itemId: 'itemId',
  name: 'name',
  sku: 'sku'
};

exports.Prisma.MealDealOrderByRelevanceFieldEnum = {
  id: 'id',
  brandId: 'brandId',
  locationIds: 'locationIds',
  name: 'name',
  description: 'description',
  imageUrl: 'imageUrl',
  plu: 'plu',
  platformSource: 'platformSource',
  externalId: 'externalId',
  syncStatus: 'syncStatus',
  syncHash: 'syncHash'
};

exports.Prisma.UpsellGroupOrderByRelevanceFieldEnum = {
  id: 'id',
  brandId: 'brandId',
  name: 'name',
  description: 'description',
  triggerProductIds: 'triggerProductIds',
  triggerCategoryIds: 'triggerCategoryIds',
  suggestedProductIds: 'suggestedProductIds',
  platformVisibility: 'platformVisibility'
};

exports.Prisma.MenuVersionOrderByRelevanceFieldEnum = {
  id: 'id',
  menuId: 'menuId',
  label: 'label',
  createdBy: 'createdBy'
};

exports.Prisma.CustomerOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  email: 'email',
  phone: 'phone',
  firstName: 'firstName',
  lastName: 'lastName',
  tags: 'tags',
  supabaseUserId: 'supabaseUserId'
};

exports.Prisma.DirectOrderingConfigOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  heroImageUrl: 'heroImageUrl'
};

exports.Prisma.CustomerAddressOrderByRelevanceFieldEnum = {
  id: 'id',
  customerId: 'customerId',
  label: 'label',
  line1: 'line1',
  line2: 'line2',
  city: 'city',
  postcode: 'postcode',
  country: 'country'
};

exports.Prisma.LoyaltyAccountOrderByRelevanceFieldEnum = {
  id: 'id',
  customerId: 'customerId',
  tenantId: 'tenantId',
  tier: 'tier'
};

exports.Prisma.PromoCodeOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  code: 'code',
  description: 'description',
  locationIds: 'locationIds'
};

exports.Prisma.DeliveryZoneOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  postcodePrefix: 'postcodePrefix'
};

exports.Prisma.LocationPaymentConfigOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  provider: 'provider'
};

exports.Prisma.OrderOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  customerId: 'customerId',
  brandId: 'brandId',
  externalId: 'externalId',
  displayId: 'displayId',
  customerName: 'customerName',
  customerPhone: 'customerPhone',
  paymentMethod: 'paymentMethod',
  promoCode: 'promoCode',
  specialInstructions: 'specialInstructions',
  idempotencyKey: 'idempotencyKey',
  collectionCode: 'collectionCode',
  failureReason: 'failureReason',
  addressLine1: 'addressLine1',
  addressLine2: 'addressLine2',
  city: 'city',
  postcode: 'postcode',
  callerId: 'callerId',
  discountType: 'discountType',
  paymentProvider: 'paymentProvider',
  cancelReason: 'cancelReason'
};

exports.Prisma.OrderNumberSequenceOrderByRelevanceFieldEnum = {
  tenantId: 'tenantId'
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
  ipAddress: 'ipAddress',
  failoverPrinterId: 'failoverPrinterId'
};

exports.Prisma.PrintJobOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  printerId: 'printerId',
  orderId: 'orderId',
  error: 'error'
};

exports.Prisma.PrintTemplateOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  name: 'name'
};

exports.Prisma.DriverOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  userId: 'userId',
  firstName: 'firstName',
  lastName: 'lastName',
  phone: 'phone',
  email: 'email',
  vehicleType: 'vehicleType'
};

exports.Prisma.DriverAssignmentOrderByRelevanceFieldEnum = {
  id: 'id',
  orderId: 'orderId',
  driverId: 'driverId'
};

exports.Prisma.DeliveryTrackingOrderByRelevanceFieldEnum = {
  id: 'id',
  assignmentId: 'assignmentId',
  event: 'event'
};

exports.Prisma.StripeConnectAccountOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  stripeAccountId: 'stripeAccountId',
  accountType: 'accountType',
  defaultCurrency: 'defaultCurrency',
  country: 'country'
};

exports.Prisma.PaymentOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  orderId: 'orderId',
  stripeConnectAccountId: 'stripeConnectAccountId',
  stripePaymentIntentId: 'stripePaymentIntentId',
  stripeChargeId: 'stripeChargeId',
  currency: 'currency'
};

exports.Prisma.PaymentMethodOrderByRelevanceFieldEnum = {
  id: 'id',
  customerId: 'customerId',
  stripePaymentMethodId: 'stripePaymentMethodId',
  last4: 'last4',
  brand: 'brand'
};

exports.Prisma.RefundOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  paymentId: 'paymentId',
  stripeRefundId: 'stripeRefundId',
  reason: 'reason',
  processedBy: 'processedBy',
  note: 'note'
};

exports.Prisma.LedgerEntryOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  paymentId: 'paymentId',
  refundId: 'refundId',
  currency: 'currency',
  description: 'description',
  reference: 'reference'
};

exports.Prisma.PayoutOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  connectAccountId: 'connectAccountId',
  stripePayoutId: 'stripePayoutId',
  currency: 'currency',
  description: 'description'
};

exports.Prisma.SupplierOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  name: 'name',
  email: 'email',
  phone: 'phone'
};

exports.Prisma.IngredientOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  supplierId: 'supplierId',
  name: 'name',
  unit: 'unit'
};

exports.Prisma.StockLevelOrderByRelevanceFieldEnum = {
  id: 'id',
  ingredientId: 'ingredientId',
  locationId: 'locationId'
};

exports.Prisma.RecipeOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  menuItemId: 'menuItemId'
};

exports.Prisma.RecipeIngredientOrderByRelevanceFieldEnum = {
  id: 'id',
  recipeId: 'recipeId',
  ingredientId: 'ingredientId'
};

exports.Prisma.StockMovementOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  ingredientId: 'ingredientId',
  reason: 'reason',
  orderId: 'orderId',
  purchaseOrderId: 'purchaseOrderId',
  recordedBy: 'recordedBy'
};

exports.Prisma.PurchaseOrderOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  supplierId: 'supplierId',
  notes: 'notes'
};

exports.Prisma.PurchaseOrderLineOrderByRelevanceFieldEnum = {
  id: 'id',
  purchaseOrderId: 'purchaseOrderId',
  ingredientId: 'ingredientId'
};

exports.Prisma.DeviceTokenOrderByRelevanceFieldEnum = {
  id: 'id',
  userId: 'userId',
  tenantId: 'tenantId',
  token: 'token',
  deviceId: 'deviceId',
  appId: 'appId'
};

exports.Prisma.NotificationLogOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  userId: 'userId',
  title: 'title',
  body: 'body',
  status: 'status',
  errorMsg: 'errorMsg'
};

exports.Prisma.TenantBrandingOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  logoUrl: 'logoUrl',
  faviconUrl: 'faviconUrl',
  primaryColor: 'primaryColor',
  secondaryColor: 'secondaryColor',
  accentColor: 'accentColor',
  fontFamily: 'fontFamily',
  customCss: 'customCss',
  appName: 'appName',
  metaTitle: 'metaTitle',
  metaDescription: 'metaDescription',
  emailFromName: 'emailFromName',
  emailFromAddr: 'emailFromAddr',
  emailFooterHtml: 'emailFooterHtml',
  senderSmsName: 'senderSmsName'
};

exports.Prisma.CustomDomainOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  brandingId: 'brandingId',
  domain: 'domain',
  txtRecord: 'txtRecord'
};

exports.Prisma.SubscriptionPlanOrderByRelevanceFieldEnum = {
  id: 'id',
  name: 'name',
  displayName: 'displayName',
  stripePriceId: 'stripePriceId'
};

exports.Prisma.TenantSubscriptionOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  planId: 'planId',
  stripeSubId: 'stripeSubId',
  stripeCustomerId: 'stripeCustomerId',
  billingEmail: 'billingEmail',
  paymentMethodStatus: 'paymentMethodStatus',
  lastInvoiceStatus: 'lastInvoiceStatus'
};

exports.Prisma.InvoiceOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  subscriptionId: 'subscriptionId',
  stripeInvoiceId: 'stripeInvoiceId',
  number: 'number',
  currency: 'currency',
  pdfUrl: 'pdfUrl'
};

exports.Prisma.InvoiceLineItemOrderByRelevanceFieldEnum = {
  id: 'id',
  invoiceId: 'invoiceId',
  description: 'description'
};

exports.Prisma.UsageRecordOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  subscriptionId: 'subscriptionId',
  locationId: 'locationId'
};

exports.Prisma.StripeWebhookEventOrderByRelevanceFieldEnum = {
  id: 'id',
  stripeEventId: 'stripeEventId',
  type: 'type',
  error: 'error'
};

exports.Prisma.MfaConfigOrderByRelevanceFieldEnum = {
  id: 'id',
  userId: 'userId',
  secret: 'secret'
};

exports.Prisma.IpAllowlistOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  cidr: 'cidr',
  label: 'label'
};

exports.Prisma.DeviceSessionOrderByRelevanceFieldEnum = {
  id: 'id',
  userId: 'userId',
  tenantId: 'tenantId',
  sessionToken: 'sessionToken',
  deviceName: 'deviceName',
  deviceType: 'deviceType',
  appVersion: 'appVersion',
  ipAddress: 'ipAddress',
  userAgent: 'userAgent'
};

exports.Prisma.DailySalesSnapshotOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  platform: 'platform'
};

exports.Prisma.ItemPerformanceSnapshotOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  menuItemId: 'menuItemId',
  locationId: 'locationId'
};

exports.Prisma.ProviderDefinitionOrderByRelevanceFieldEnum = {
  id: 'id',
  key: 'key',
  name: 'name',
  webhookPath: 'webhookPath',
  logoUrl: 'logoUrl',
  docsUrl: 'docsUrl'
};

exports.Prisma.WebhookRouteOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  providerKey: 'providerKey',
  pathPattern: 'pathPattern'
};

exports.Prisma.MobileSessionOrderByRelevanceFieldEnum = {
  id: 'id',
  userId: 'userId',
  tenantId: 'tenantId',
  appId: 'appId',
  deviceId: 'deviceId',
  deviceModel: 'deviceModel',
  osVersion: 'osVersion',
  appVersion: 'appVersion',
  fcmToken: 'fcmToken'
};

exports.Prisma.WebPushSubscriptionOrderByRelevanceFieldEnum = {
  id: 'id',
  userId: 'userId',
  tenantId: 'tenantId',
  endpoint: 'endpoint',
  p256dh: 'p256dh',
  auth: 'auth'
};

exports.Prisma.OutboxEventOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  aggregateType: 'aggregateType',
  aggregateId: 'aggregateId',
  eventType: 'eventType',
  lastError: 'lastError',
  idempotencyKey: 'idempotencyKey'
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

exports.LocationGoLiveStatus = exports.$Enums.LocationGoLiveStatus = {
  DRAFT: 'DRAFT',
  CONFIGURING: 'CONFIGURING',
  TESTING: 'TESTING',
  READY_FOR_GO_LIVE: 'READY_FOR_GO_LIVE',
  LIVE: 'LIVE',
  PAUSED: 'PAUSED',
  BLOCKED: 'BLOCKED'
};

exports.IntegrationPlatform = exports.$Enums.IntegrationPlatform = {
  UBER_EATS: 'UBER_EATS',
  DELIVEROO: 'DELIVEROO',
  JUST_EAT: 'JUST_EAT',
  HUBRISE: 'HUBRISE',
  DIRECT: 'DIRECT',
  TALABAT: 'TALABAT',
  DOORDASH: 'DOORDASH',
  GRUBHUB: 'GRUBHUB',
  CAREEM: 'CAREEM'
};

exports.IntegrationStatus = exports.$Enums.IntegrationStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  ERROR: 'ERROR',
  PENDING_SETUP: 'PENDING_SETUP'
};

exports.MenuType = exports.$Enums.MenuType = {
  DELIVERY: 'DELIVERY',
  DELIVERY_AND_PICKUP: 'DELIVERY_AND_PICKUP'
};

exports.MenuStatus = exports.$Enums.MenuStatus = {
  DRAFT: 'DRAFT',
  PUBLISHED: 'PUBLISHED',
  ARCHIVED: 'ARCHIVED'
};

exports.MenuImportStatus = exports.$Enums.MenuImportStatus = {
  IDLE: 'IDLE',
  IMPORTING: 'IMPORTING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED'
};

exports.SelectionType = exports.$Enums.SelectionType = {
  VARIANT: 'VARIANT',
  ADDON: 'ADDON'
};

exports.PromoCodeType = exports.$Enums.PromoCodeType = {
  PERCENTAGE: 'PERCENTAGE',
  FIXED_AMOUNT: 'FIXED_AMOUNT',
  FREE_DELIVERY: 'FREE_DELIVERY'
};

exports.OrderPlatform = exports.$Enums.OrderPlatform = {
  UBER_EATS: 'UBER_EATS',
  DELIVEROO: 'DELIVEROO',
  JUST_EAT: 'JUST_EAT',
  HUBRISE: 'HUBRISE',
  DIRECT: 'DIRECT',
  POS: 'POS',
  ONLINE: 'ONLINE',
  TALABAT: 'TALABAT',
  DOORDASH: 'DOORDASH',
  GRUBHUB: 'GRUBHUB',
  CAREEM: 'CAREEM'
};

exports.OrderSource = exports.$Enums.OrderSource = {
  ONLINE: 'ONLINE',
  POS: 'POS',
  UBER_EATS: 'UBER_EATS',
  DELIVEROO: 'DELIVEROO',
  JUST_EAT: 'JUST_EAT',
  HUBRISE: 'HUBRISE',
  DIRECT: 'DIRECT',
  TALABAT: 'TALABAT',
  DOORDASH: 'DOORDASH',
  GRUBHUB: 'GRUBHUB',
  CAREEM: 'CAREEM'
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
  PENDING_DISPATCH: 'PENDING_DISPATCH',
  ASSIGNED_DRIVER: 'ASSIGNED_DRIVER',
  ACCEPTED_BY_DRIVER: 'ACCEPTED_BY_DRIVER',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DISPATCHED: 'DISPATCHED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED'
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

exports.DriverAssignmentStatus = exports.$Enums.DriverAssignmentStatus = {
  ASSIGNED: 'ASSIGNED',
  ACCEPTED: 'ACCEPTED',
  PICKED_UP: 'PICKED_UP',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED'
};

exports.PaymentRecordStatus = exports.$Enums.PaymentRecordStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  REFUNDED: 'REFUNDED'
};

exports.PaymentMethodType = exports.$Enums.PaymentMethodType = {
  CARD: 'CARD',
  APPLE_PAY: 'APPLE_PAY',
  GOOGLE_PAY: 'GOOGLE_PAY',
  CASH: 'CASH',
  VOUCHER: 'VOUCHER',
  BANK_TRANSFER: 'BANK_TRANSFER',
  CRYPTO: 'CRYPTO'
};

exports.RefundStatus = exports.$Enums.RefundStatus = {
  PENDING: 'PENDING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
};

exports.LedgerEntryType = exports.$Enums.LedgerEntryType = {
  PAYMENT: 'PAYMENT',
  REFUND: 'REFUND',
  PAYOUT: 'PAYOUT',
  PLATFORM_FEE: 'PLATFORM_FEE',
  PROCESSING_FEE: 'PROCESSING_FEE',
  ADJUSTMENT: 'ADJUSTMENT',
  TIP: 'TIP'
};

exports.PayoutStatus = exports.$Enums.PayoutStatus = {
  PENDING: 'PENDING',
  IN_TRANSIT: 'IN_TRANSIT',
  PAID: 'PAID',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
};

exports.StockMovementType = exports.$Enums.StockMovementType = {
  PURCHASE: 'PURCHASE',
  SALE_DEDUCTION: 'SALE_DEDUCTION',
  WASTE: 'WASTE',
  ADJUSTMENT: 'ADJUSTMENT',
  TRANSFER_IN: 'TRANSFER_IN',
  TRANSFER_OUT: 'TRANSFER_OUT',
  RETURN: 'RETURN',
  COUNT_CORRECTION: 'COUNT_CORRECTION'
};

exports.PurchaseOrderStatus = exports.$Enums.PurchaseOrderStatus = {
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  ORDERED: 'ORDERED',
  PARTIAL: 'PARTIAL',
  RECEIVED: 'RECEIVED',
  CANCELLED: 'CANCELLED'
};

exports.DevicePlatform = exports.$Enums.DevicePlatform = {
  IOS: 'IOS',
  ANDROID: 'ANDROID',
  WEB: 'WEB'
};

exports.NotificationType = exports.$Enums.NotificationType = {
  ORDER_NEW: 'ORDER_NEW',
  ORDER_UPDATED: 'ORDER_UPDATED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  DRIVER_ASSIGNED: 'DRIVER_ASSIGNED',
  DELIVERY_UPDATE: 'DELIVERY_UPDATE',
  PRINT_FAILURE: 'PRINT_FAILURE',
  INTEGRATION_FAILURE: 'INTEGRATION_FAILURE',
  LOW_STOCK: 'LOW_STOCK',
  MARKETING: 'MARKETING',
  SYSTEM: 'SYSTEM'
};

exports.NotificationChannel = exports.$Enums.NotificationChannel = {
  FCM: 'FCM',
  APNS: 'APNS',
  WEB_PUSH: 'WEB_PUSH',
  SMS: 'SMS',
  EMAIL: 'EMAIL',
  IN_APP: 'IN_APP'
};

exports.DomainStatus = exports.$Enums.DomainStatus = {
  PENDING: 'PENDING',
  VERIFYING: 'VERIFYING',
  VERIFIED: 'VERIFIED',
  ACTIVE: 'ACTIVE',
  FAILED: 'FAILED'
};

exports.SubscriptionStatus = exports.$Enums.SubscriptionStatus = {
  TRIALING: 'TRIALING',
  ACTIVE: 'ACTIVE',
  PAST_DUE: 'PAST_DUE',
  CANCELLED: 'CANCELLED',
  PAUSED: 'PAUSED',
  INCOMPLETE: 'INCOMPLETE',
  FREE_PILOT: 'FREE_PILOT',
  UNPAID: 'UNPAID'
};

exports.InvoiceStatus = exports.$Enums.InvoiceStatus = {
  DRAFT: 'DRAFT',
  OPEN: 'OPEN',
  PAID: 'PAID',
  VOID: 'VOID',
  UNCOLLECTIBLE: 'UNCOLLECTIBLE'
};

exports.ProviderCategory = exports.$Enums.ProviderCategory = {
  DELIVERY_MARKETPLACE: 'DELIVERY_MARKETPLACE',
  OWN_DELIVERY: 'OWN_DELIVERY',
  POS: 'POS',
  DISPATCH: 'DISPATCH',
  ACCOUNTING: 'ACCOUNTING',
  MARKETING: 'MARKETING',
  PAYMENT: 'PAYMENT'
};

exports.OutboxEventStatus = exports.$Enums.OutboxEventStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  PROCESSED: 'PROCESSED',
  FAILED: 'FAILED',
  DEAD: 'DEAD'
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
  BrandPlatformConnection: 'BrandPlatformConnection',
  Integration: 'Integration',
  Menu: 'Menu',
  MenuCategory: 'MenuCategory',
  MenuItem: 'MenuItem',
  MenuItemOnCategory: 'MenuItemOnCategory',
  ModifierGroup: 'ModifierGroup',
  ModifierOption: 'ModifierOption',
  ModifierGroupOnItem: 'ModifierGroupOnItem',
  MenuItemVariant: 'MenuItemVariant',
  MealDeal: 'MealDeal',
  UpsellGroup: 'UpsellGroup',
  MenuVersion: 'MenuVersion',
  Customer: 'Customer',
  DirectOrderingConfig: 'DirectOrderingConfig',
  CustomerAddress: 'CustomerAddress',
  LoyaltyAccount: 'LoyaltyAccount',
  PromoCode: 'PromoCode',
  DeliveryZone: 'DeliveryZone',
  LocationPaymentConfig: 'LocationPaymentConfig',
  Order: 'Order',
  OrderNumberSequence: 'OrderNumberSequence',
  OrderItem: 'OrderItem',
  OrderStatusHistory: 'OrderStatusHistory',
  WebhookEvent: 'WebhookEvent',
  KdsScreen: 'KdsScreen',
  KdsTicket: 'KdsTicket',
  Printer: 'Printer',
  PrintJob: 'PrintJob',
  PrintTemplate: 'PrintTemplate',
  Driver: 'Driver',
  DriverAssignment: 'DriverAssignment',
  DeliveryTracking: 'DeliveryTracking',
  StripeConnectAccount: 'StripeConnectAccount',
  Payment: 'Payment',
  PaymentMethod: 'PaymentMethod',
  Refund: 'Refund',
  LedgerEntry: 'LedgerEntry',
  Payout: 'Payout',
  Supplier: 'Supplier',
  Ingredient: 'Ingredient',
  StockLevel: 'StockLevel',
  Recipe: 'Recipe',
  RecipeIngredient: 'RecipeIngredient',
  StockMovement: 'StockMovement',
  PurchaseOrder: 'PurchaseOrder',
  PurchaseOrderLine: 'PurchaseOrderLine',
  DeviceToken: 'DeviceToken',
  NotificationLog: 'NotificationLog',
  TenantBranding: 'TenantBranding',
  CustomDomain: 'CustomDomain',
  SubscriptionPlan: 'SubscriptionPlan',
  TenantSubscription: 'TenantSubscription',
  Invoice: 'Invoice',
  InvoiceLineItem: 'InvoiceLineItem',
  UsageRecord: 'UsageRecord',
  StripeWebhookEvent: 'StripeWebhookEvent',
  MfaConfig: 'MfaConfig',
  IpAllowlist: 'IpAllowlist',
  DeviceSession: 'DeviceSession',
  DailySalesSnapshot: 'DailySalesSnapshot',
  ItemPerformanceSnapshot: 'ItemPerformanceSnapshot',
  ProviderDefinition: 'ProviderDefinition',
  WebhookRoute: 'WebhookRoute',
  MobileSession: 'MobileSession',
  WebPushSubscription: 'WebPushSubscription',
  OutboxEvent: 'OutboxEvent'
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
