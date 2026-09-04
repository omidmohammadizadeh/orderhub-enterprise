
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

exports.Prisma.UserLocationScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  locationId: 'locationId',
  createdAt: 'createdAt'
};

exports.Prisma.UserBrandScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  brandId: 'brandId',
  createdAt: 'createdAt'
};

exports.Prisma.InvitationScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  email: 'email',
  role: 'role',
  locationIds: 'locationIds',
  brandIds: 'brandIds',
  token: 'token',
  expiresAt: 'expiresAt',
  acceptedAt: 'acceptedAt',
  cancelledAt: 'cancelledAt',
  invitedById: 'invitedById',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.LeadScalarFieldEnum = {
  id: 'id',
  firstName: 'firstName',
  lastName: 'lastName',
  email: 'email',
  phone: 'phone',
  country: 'country',
  companyName: 'companyName',
  numberOfLocations: 'numberOfLocations',
  hearAboutUs: 'hearAboutUs',
  message: 'message',
  source: 'source',
  status: 'status',
  submittedByUserId: 'submittedByUserId',
  notes: 'notes',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.CustomerAccountScalarFieldEnum = {
  id: 'id',
  email: 'email',
  password: 'password',
  firstName: 'firstName',
  lastName: 'lastName',
  phone: 'phone',
  googleId: 'googleId',
  avatarUrl: 'avatarUrl',
  isVerified: 'isVerified',
  emailVerificationToken: 'emailVerificationToken',
  marketingOptIn: 'marketingOptIn',
  lastLoginAt: 'lastLoginAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.PasswordResetTokenScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  tokenHash: 'tokenHash',
  expiresAt: 'expiresAt',
  usedAt: 'usedAt',
  requestedIp: 'requestedIp',
  userAgent: 'userAgent',
  createdAt: 'createdAt'
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
  topSellerItemIds: 'topSellerItemIds',
  onlineOrderingSlug: 'onlineOrderingSlug',
  directOrderingEnabled: 'directOrderingEnabled',
  about: 'about',
  phone: 'phone',
  addressLine1: 'addressLine1',
  addressLine2: 'addressLine2',
  city: 'city',
  postcode: 'postcode',
  country: 'country',
  customDomain: 'customDomain',
  customDomainStatus: 'customDomainStatus',
  stripeConnectedAccountId: 'stripeConnectedAccountId',
  tapDestinationId: 'tapDestinationId',
  tapBusinessId: 'tapBusinessId',
  applicationFeeFixedAmount: 'applicationFeeFixedAmount',
  applicationFeePercentage: 'applicationFeePercentage',
  applicationFeeMode: 'applicationFeeMode',
  openingHours: 'openingHours',
  prepTime: 'prepTime',
  busyExtraPrepTime: 'busyExtraPrepTime',
  defaultStationId: 'defaultStationId',
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
  defaultKitchenStationId: 'defaultKitchenStationId',
  receiptPrinterId: 'receiptPrinterId',
  dispatchPrinterId: 'dispatchPrinterId',
  addressLine1: 'addressLine1',
  addressLine2: 'addressLine2',
  city: 'city',
  postcode: 'postcode',
  country: 'country',
  currency: 'currency',
  about: 'about',
  logoUrl: 'logoUrl',
  customDomain: 'customDomain',
  customDomainStatus: 'customDomainStatus',
  onlineOrderingSlug: 'onlineOrderingSlug',
  hubriseCredentials: 'hubriseCredentials',
  hubriseCatalogId: 'hubriseCatalogId',
  hubriseLocationId: 'hubriseLocationId',
  hubriseConnectedAt: 'hubriseConnectedAt',
  stripeConnectedAccountId: 'stripeConnectedAccountId',
  applicationFeeFixedAmount: 'applicationFeeFixedAmount',
  applicationFeePercentage: 'applicationFeePercentage',
  applicationFeeMode: 'applicationFeeMode',
  posStripeAccountId: 'posStripeAccountId',
  posApplicationFeePercent: 'posApplicationFeePercent',
  posApplicationFeeFixedMinor: 'posApplicationFeeFixedMinor',
  posTerminalApplicationFeePercent: 'posTerminalApplicationFeePercent',
  posTerminalApplicationFeeFixedMinor: 'posTerminalApplicationFeeFixedMinor',
  status: 'status',
  googleReviewUrl: 'googleReviewUrl',
  busyModeJson: 'busyModeJson',
  shopCode: 'shopCode',
  printToken: 'printToken',
  slug: 'slug',
  openingHours: 'openingHours',
  deliveryConfig: 'deliveryConfig',
  prepTime: 'prepTime',
  busyExtraPrepTime: 'busyExtraPrepTime',
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
  latitude: 'latitude',
  longitude: 'longitude',
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
  pricingVariants: 'pricingVariants',
  metadata: 'metadata',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.MenuChannelAssignmentScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  menuId: 'menuId',
  locationId: 'locationId',
  brandId: 'brandId',
  channel: 'channel',
  publishedAt: 'publishedAt',
  createdBy: 'createdBy',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.BrandChannelSourceScalarFieldEnum = {
  id: 'id',
  brandId: 'brandId',
  channel: 'channel',
  sourceMenuId: 'sourceMenuId',
  variantRef: 'variantRef',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.MenuCategoryScalarFieldEnum = {
  id: 'id',
  menuId: 'menuId',
  name: 'name',
  description: 'description',
  secondLanguageName: 'secondLanguageName',
  imageUrl: 'imageUrl',
  sortOrder: 'sortOrder',
  isVisible: 'isVisible',
  menuIds: 'menuIds',
  available: 'available',
  visibleToCustomers: 'visibleToCustomers',
  availableCollection: 'availableCollection',
  availableDelivery: 'availableDelivery',
  availableDineIn: 'availableDineIn',
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
  locationId: 'locationId',
  name: 'name',
  description: 'description',
  secondLanguageName: 'secondLanguageName',
  basePrice: 'basePrice',
  imageUrl: 'imageUrl',
  sku: 'sku',
  plu: 'plu',
  isAvailable: 'isAvailable',
  visibleToCustomers: 'visibleToCustomers',
  outOfStock: 'outOfStock',
  availableCollection: 'availableCollection',
  availableDelivery: 'availableDelivery',
  availableDineIn: 'availableDineIn',
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

exports.Prisma.ChannelPauseScalarFieldEnum = {
  id: 'id',
  locationId: 'locationId',
  brandId: 'brandId',
  channel: 'channel',
  mode: 'mode',
  resumeAt: 'resumeAt',
  reason: 'reason',
  extraPrepTime: 'extraPrepTime',
  pausedAt: 'pausedAt',
  pausedBy: 'pausedBy',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.MenuItemChannelAvailabilityScalarFieldEnum = {
  id: 'id',
  itemId: 'itemId',
  channel: 'channel',
  locationId: 'locationId',
  isAvailable: 'isAvailable',
  expiresAt: 'expiresAt',
  snoozeReason: 'snoozeReason',
  snoozedAt: 'snoozedAt',
  snoozedBy: 'snoozedBy',
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
  locationId: 'locationId',
  name: 'name',
  description: 'description',
  secondLanguageName: 'secondLanguageName',
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
  secondLanguageName: 'secondLanguageName',
  priceAdjustment: 'priceAdjustment',
  plu: 'plu',
  pricesBySize: 'pricesBySize',
  skuPlus: 'skuPlus',
  platformPricingOverrides: 'platformPricingOverrides',
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

exports.Prisma.ModifierOptionNestedGroupScalarFieldEnum = {
  optionId: 'optionId',
  groupId: 'groupId',
  sortOrder: 'sortOrder',
  createdAt: 'createdAt'
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
  brandId: 'brandId',
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
  showItemImages: 'showItemImages',
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

exports.Prisma.MarketingCampaignScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  brandId: 'brandId',
  name: 'name',
  description: 'description',
  type: 'type',
  status: 'status',
  audience: 'audience',
  channels: 'channels',
  percentageOff: 'percentageOff',
  amountOff: 'amountOff',
  minOrder: 'minOrder',
  freeItemId: 'freeItemId',
  itemIds: 'itemIds',
  dailyStartTime: 'dailyStartTime',
  dailyEndTime: 'dailyEndTime',
  startsAt: 'startsAt',
  endsAt: 'endsAt',
  maxRedemptions: 'maxRedemptions',
  perCustomerLimit: 'perCustomerLimit',
  redemptionCount: 'redemptionCount',
  metadata: 'metadata',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  createdBy: 'createdBy'
};

exports.Prisma.CampaignRedemptionScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  campaignId: 'campaignId',
  brandId: 'brandId',
  orderId: 'orderId',
  channel: 'channel',
  customerAccountId: 'customerAccountId',
  isNewCustomer: 'isNewCustomer',
  discountAmount: 'discountAmount',
  orderTotal: 'orderTotal',
  createdAt: 'createdAt'
};

exports.Prisma.DeliveryZoneScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  brandId: 'brandId',
  postcodePrefix: 'postcodePrefix',
  areaName: 'areaName',
  maxDistanceMiles: 'maxDistanceMiles',
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
  customerAccountId: 'customerAccountId',
  brandId: 'brandId',
  externalId: 'externalId',
  platform: 'platform',
  displayId: 'displayId',
  orderNumber: 'orderNumber',
  orderSource: 'orderSource',
  integrationSource: 'integrationSource',
  viaHubrise: 'viaHubrise',
  deliveryType: 'deliveryType',
  courierName: 'courierName',
  courierPhone: 'courierPhone',
  courierPhoneAccessCode: 'courierPhoneAccessCode',
  courierTrackingUrl: 'courierTrackingUrl',
  courierStatus: 'courierStatus',
  courierAssignedAt: 'courierAssignedAt',
  courierPickedUpAt: 'courierPickedUpAt',
  courierDeliveredAt: 'courierDeliveredAt',
  courierEtaAt: 'courierEtaAt',
  courierPickupEtaAt: 'courierPickupEtaAt',
  courierLat: 'courierLat',
  courierLng: 'courierLng',
  courierLocationAt: 'courierLocationAt',
  courierProvider: 'courierProvider',
  courierJobId: 'courierJobId',
  status: 'status',
  fulfillmentType: 'fulfillmentType',
  tableId: 'tableId',
  covers: 'covers',
  isWalkIn: 'isWalkIn',
  customerInfo: 'customerInfo',
  customerName: 'customerName',
  customerPhone: 'customerPhone',
  deliveryAddress: 'deliveryAddress',
  deliveryLat: 'deliveryLat',
  deliveryLng: 'deliveryLng',
  geocodedAt: 'geocodedAt',
  subtotal: 'subtotal',
  taxAmount: 'taxAmount',
  serviceCharge: 'serviceCharge',
  tipAmount: 'tipAmount',
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

exports.Prisma.ActivityLogScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  brandId: 'brandId',
  category: 'category',
  channel: 'channel',
  action: 'action',
  status: 'status',
  message: 'message',
  details: 'details',
  createdAt: 'createdAt'
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

exports.Prisma.SignageDisplayScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  brandId: 'brandId',
  name: 'name',
  publicToken: 'publicToken',
  categoryIds: 'categoryIds',
  orientation: 'orientation',
  config: 'config',
  isActive: 'isActive',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.TableScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  name: 'name',
  seats: 'seats',
  area: 'area',
  sortOrder: 'sortOrder',
  isActive: 'isActive',
  status: 'status',
  currentOrderId: 'currentOrderId',
  openedAt: 'openedAt',
  posX: 'posX',
  posY: 'posY',
  shape: 'shape',
  width: 'width',
  height: 'height',
  bookableOnline: 'bookableOnline',
  outOfService: 'outOfService',
  outOfServiceNote: 'outOfServiceNote',
  qrToken: 'qrToken',
  qrEnabled: 'qrEnabled',
  covers: 'covers',
  serverId: 'serverId',
  serverName: 'serverName',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.KioskDeviceScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  brandId: 'brandId',
  name: 'name',
  publicToken: 'publicToken',
  isActive: 'isActive',
  config: 'config',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.TableReservationScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  tableId: 'tableId',
  customerName: 'customerName',
  customerPhone: 'customerPhone',
  customerEmail: 'customerEmail',
  partySize: 'partySize',
  startsAt: 'startsAt',
  durationMins: 'durationMins',
  status: 'status',
  source: 'source',
  notes: 'notes',
  orderId: 'orderId',
  seatedAt: 'seatedAt',
  cancelledAt: 'cancelledAt',
  reference: 'reference',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.KdsTicketScalarFieldEnum = {
  id: 'id',
  kdsScreenId: 'kdsScreenId',
  orderId: 'orderId',
  bumpedAt: 'bumpedAt',
  recalledAt: 'recalledAt',
  metadata: 'metadata',
  createdAt: 'createdAt'
};

exports.Prisma.PrinterScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  name: 'name',
  type: 'type',
  connectionType: 'connectionType',
  usbVendor: 'usbVendor',
  usbProduct: 'usbProduct',
  kind: 'kind',
  ipAddress: 'ipAddress',
  port: 'port',
  isOnline: 'isOnline',
  isActive: 'isActive',
  deletedAt: 'deletedAt',
  failoverPrinterId: 'failoverPrinterId',
  model: 'model',
  paperWidth: 'paperWidth',
  agentId: 'agentId',
  supportsReceipts: 'supportsReceipts',
  supportsKitchen: 'supportsKitchen',
  supportsLabels: 'supportsLabels',
  supportsCut: 'supportsCut',
  supportsCashDrawer: 'supportsCashDrawer',
  supportsBluetooth: 'supportsBluetooth',
  supportsUsb: 'supportsUsb',
  supportsLan: 'supportsLan',
  supportsEscPos: 'supportsEscPos',
  supportsQrCode: 'supportsQrCode',
  supportsImages: 'supportsImages',
  defaults: 'defaults',
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
  stationId: 'stationId',
  trigger: 'trigger',
  claimedByAgentId: 'claimedByAgentId',
  claimedAt: 'claimedAt',
  routeKey: 'routeKey',
  idempotencyKey: 'idempotencyKey',
  copies: 'copies',
  nextRetryAt: 'nextRetryAt',
  failureReason: 'failureReason',
  deadLetteredAt: 'deadLetteredAt',
  lastError: 'lastError',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.PrinterStationScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  name: 'name',
  kind: 'kind',
  defaultPrinterId: 'defaultPrinterId',
  isActive: 'isActive',
  sortOrder: 'sortOrder',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.PrintAgentScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  name: 'name',
  kind: 'kind',
  apiTokenHash: 'apiTokenHash',
  capabilities: 'capabilities',
  versionString: 'versionString',
  deviceId: 'deviceId',
  deviceName: 'deviceName',
  osType: 'osType',
  hostname: 'hostname',
  printerCount: 'printerCount',
  lastSeenAt: 'lastSeenAt',
  isActive: 'isActive',
  deletedAt: 'deletedAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.AlertConfigScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  stationId: 'stationId',
  trigger: 'trigger',
  enabled: 'enabled',
  soundUrl: 'soundUrl',
  volume: 'volume',
  repeatCount: 'repeatCount',
  repeatIntervalMs: 'repeatIntervalMs',
  autoStopSeconds: 'autoStopSeconds',
  requireAcknowledgement: 'requireAcknowledgement',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.AlertAckScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  trigger: 'trigger',
  referenceKey: 'referenceKey',
  acknowledgedById: 'acknowledgedById',
  acknowledgedAt: 'acknowledgedAt'
};

exports.Prisma.AgentPairCodeScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  code: 'code',
  createdById: 'createdById',
  expiresAt: 'expiresAt',
  usedAt: 'usedAt',
  agentId: 'agentId',
  createdAt: 'createdAt'
};

exports.Prisma.MenuItemStationScalarFieldEnum = {
  id: 'id',
  menuItemId: 'menuItemId',
  stationId: 'stationId',
  createdAt: 'createdAt'
};

exports.Prisma.ModifierGroupStationScalarFieldEnum = {
  id: 'id',
  modifierGroupId: 'modifierGroupId',
  stationId: 'stationId',
  createdAt: 'createdAt'
};

exports.Prisma.MenuCategoryStationScalarFieldEnum = {
  id: 'id',
  categoryId: 'categoryId',
  stationId: 'stationId',
  createdAt: 'createdAt'
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
  locationId: 'locationId',
  startupFee: 'startupFee',
  postcodeFees: 'postcodeFees',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.DriverCashUpScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  driverId: 'driverId',
  locationId: 'locationId',
  periodStart: 'periodStart',
  periodEnd: 'periodEnd',
  cashOrders: 'cashOrders',
  cashCollected: 'cashCollected',
  cardOrders: 'cardOrders',
  cardCollected: 'cardCollected',
  deliveries: 'deliveries',
  driverEarning: 'driverEarning',
  cashHandover: 'cashHandover',
  createdBy: 'createdBy',
  createdAt: 'createdAt'
};

exports.Prisma.DriverPresenceScalarFieldEnum = {
  id: 'id',
  driverId: 'driverId',
  tenantId: 'tenantId',
  locationId: 'locationId',
  status: 'status',
  lat: 'lat',
  lng: 'lng',
  heading: 'heading',
  speed: 'speed',
  activeAssignmentId: 'activeAssignmentId',
  socketId: 'socketId',
  pushToken: 'pushToken',
  lastPingAt: 'lastPingAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.DriverAssignmentScalarFieldEnum = {
  id: 'id',
  orderId: 'orderId',
  driverId: 'driverId',
  status: 'status',
  sequence: 'sequence',
  assignedAt: 'assignedAt',
  acceptedAt: 'acceptedAt',
  pickedUpAt: 'pickedUpAt',
  arrivedAt: 'arrivedAt',
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

exports.Prisma.ChatMessageScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  channel: 'channel',
  driverId: 'driverId',
  orderId: 'orderId',
  senderType: 'senderType',
  senderName: 'senderName',
  body: 'body',
  createdAt: 'createdAt',
  readByOperatorAt: 'readByOperatorAt',
  readByDriverAt: 'readByDriverAt',
  readByCustomerAt: 'readByCustomerAt'
};

exports.Prisma.WhatsAppConversationScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  brandId: 'brandId',
  waPhone: 'waPhone',
  phoneNumberId: 'phoneNumberId',
  state: 'state',
  cart: 'cart',
  messages: 'messages',
  customerName: 'customerName',
  lastOrderId: 'lastOrderId',
  lastInboundAt: 'lastInboundAt',
  lastOutboundAt: 'lastOutboundAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.StripeConnectAccountScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  brandId: 'brandId',
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
  provider: 'provider',
  providerChargeId: 'providerChargeId',
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

exports.Prisma.MerchantSubscriptionScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  stripeCustomerId: 'stripeCustomerId',
  stripeSubscriptionId: 'stripeSubscriptionId',
  stripePriceId: 'stripePriceId',
  stripeCheckoutId: 'stripeCheckoutId',
  monthlyAmountPence: 'monthlyAmountPence',
  currency: 'currency',
  status: 'status',
  currentPeriodStart: 'currentPeriodStart',
  currentPeriodEnd: 'currentPeriodEnd',
  cancelAtPeriodEnd: 'cancelAtPeriodEnd',
  trialEndsAt: 'trialEndsAt',
  defaultPaymentBrand: 'defaultPaymentBrand',
  defaultPaymentLast4: 'defaultPaymentLast4',
  lastInvoiceStatus: 'lastInvoiceStatus',
  lastFailureMessage: 'lastFailureMessage',
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

exports.Prisma.SystemSecretScalarFieldEnum = {
  id: 'id',
  key: 'key',
  label: 'label',
  description: 'description',
  category: 'category',
  encryptedValue: 'encryptedValue',
  lastFourChars: 'lastFourChars',
  createdBy: 'createdBy',
  updatedBy: 'updatedBy',
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

exports.Prisma.VideoStudioAccountScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  addonActive: 'addonActive',
  stripeSubscriptionId: 'stripeSubscriptionId',
  includedMonthly: 'includedMonthly',
  includedBalance: 'includedBalance',
  topupBalance: 'topupBalance',
  lastGrantAt: 'lastGrantAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.VideoCreditTxnScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  delta: 'delta',
  reason: 'reason',
  source: 'source',
  generationId: 'generationId',
  note: 'note',
  createdAt: 'createdAt'
};

exports.Prisma.VideoGenerationScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  userId: 'userId',
  locationId: 'locationId',
  brandId: 'brandId',
  status: 'status',
  kind: 'kind',
  model: 'model',
  prompt: 'prompt',
  sourceImageUrl: 'sourceImageUrl',
  resultUrl: 'resultUrl',
  replicatePredictionId: 'replicatePredictionId',
  creditsCost: 'creditsCost',
  error: 'error',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.SmsMessageScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  brandId: 'brandId',
  orderId: 'orderId',
  toNumber: 'toNumber',
  purpose: 'purpose',
  campaignId: 'campaignId',
  segments: 'segments',
  provider: 'provider',
  providerSid: 'providerSid',
  status: 'status',
  error: 'error',
  createdBy: 'createdBy',
  createdAt: 'createdAt'
};

exports.Prisma.MarketingContactScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  phone: 'phone',
  firstName: 'firstName',
  lastName: 'lastName',
  email: 'email',
  source: 'source',
  customerId: 'customerId',
  consentStatus: 'consentStatus',
  consentSource: 'consentSource',
  consentAt: 'consentAt',
  unsubscribedAt: 'unsubscribedAt',
  tags: 'tags',
  lastCampaignAt: 'lastCampaignAt',
  createdBy: 'createdBy',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.MarketingSmsCampaignScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  name: 'name',
  senderHeader: 'senderHeader',
  body: 'body',
  status: 'status',
  audience: 'audience',
  recipientCount: 'recipientCount',
  sentCount: 'sentCount',
  failedCount: 'failedCount',
  skippedCount: 'skippedCount',
  segments: 'segments',
  costMinor: 'costMinor',
  createdBy: 'createdBy',
  startedAt: 'startedAt',
  completedAt: 'completedAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.MarketingSmsRecipientScalarFieldEnum = {
  id: 'id',
  campaignId: 'campaignId',
  tenantId: 'tenantId',
  contactId: 'contactId',
  phone: 'phone',
  status: 'status',
  reason: 'reason',
  segments: 'segments',
  smsMessageId: 'smsMessageId',
  createdAt: 'createdAt'
};

exports.Prisma.WalletScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  balanceMinor: 'balanceMinor',
  currency: 'currency',
  smsPricePerSegmentMinor: 'smsPricePerSegmentMinor',
  voicePricePerCallMinor: 'voicePricePerCallMinor',
  lowBalanceThresholdMinor: 'lowBalanceThresholdMinor',
  stripeCustomerId: 'stripeCustomerId',
  autoTopupEnabled: 'autoTopupEnabled',
  autoTopupThresholdMinor: 'autoTopupThresholdMinor',
  autoTopupAmountMinor: 'autoTopupAmountMinor',
  stripePaymentMethodId: 'stripePaymentMethodId',
  autoTopupLastAt: 'autoTopupLastAt',
  autoTopupFailedAt: 'autoTopupFailedAt',
  autoTopupFailureReason: 'autoTopupFailureReason',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.WalletTransactionScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  walletId: 'walletId',
  type: 'type',
  amountMinor: 'amountMinor',
  balanceAfterMinor: 'balanceAfterMinor',
  currency: 'currency',
  purpose: 'purpose',
  segments: 'segments',
  smsMessageId: 'smsMessageId',
  orderId: 'orderId',
  voiceCallId: 'voiceCallId',
  locationId: 'locationId',
  stripeCheckoutId: 'stripeCheckoutId',
  stripePaymentIntentId: 'stripePaymentIntentId',
  description: 'description',
  createdBy: 'createdBy',
  createdAt: 'createdAt'
};

exports.Prisma.StuartConfigScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  environment: 'environment',
  credentials: 'credentials',
  webhookAuthKey: 'webhookAuthKey',
  active: 'active',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.UberDirectConfigScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  environment: 'environment',
  credentials: 'credentials',
  active: 'active',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.ReviewScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  orderId: 'orderId',
  locationId: 'locationId',
  brandId: 'brandId',
  customerId: 'customerId',
  customerName: 'customerName',
  rating: 'rating',
  comment: 'comment',
  status: 'status',
  reply: 'reply',
  repliedAt: 'repliedAt',
  repliedBy: 'repliedBy',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.VoiceCallScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  brandId: 'brandId',
  providerCallId: 'providerCallId',
  provider: 'provider',
  fromNumber: 'fromNumber',
  toNumber: 'toNumber',
  direction: 'direction',
  status: 'status',
  notAnsweredReason: 'notAnsweredReason',
  answeredAt: 'answeredAt',
  endedAt: 'endedAt',
  durationSeconds: 'durationSeconds',
  outcome: 'outcome',
  orderId: 'orderId',
  reservationId: 'reservationId',
  wasOverflow: 'wasOverflow',
  billedMinor: 'billedMinor',
  billedAt: 'billedAt',
  transcript: 'transcript',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.GroupOrderScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  token: 'token',
  locationId: 'locationId',
  brandId: 'brandId',
  hostCustomerId: 'hostCustomerId',
  hostName: 'hostName',
  hostRef: 'hostRef',
  status: 'status',
  orderId: 'orderId',
  fulfillmentType: 'fulfillmentType',
  paymentMode: 'paymentMode',
  expiresAt: 'expiresAt',
  placedAt: 'placedAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.GroupOrderItemScalarFieldEnum = {
  id: 'id',
  groupOrderId: 'groupOrderId',
  addedByName: 'addedByName',
  addedByRef: 'addedByRef',
  cartItem: 'cartItem',
  quantity: 'quantity',
  lineTotal: 'lineTotal',
  isPaid: 'isPaid',
  paidAt: 'paidAt',
  paymentId: 'paymentId',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.CustomerPushSubscriptionScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  brandId: 'brandId',
  endpoint: 'endpoint',
  p256dh: 'p256dh',
  auth: 'auth',
  customerId: 'customerId',
  deviceRef: 'deviceRef',
  userAgent: 'userAgent',
  isActive: 'isActive',
  revokedAt: 'revokedAt',
  lastSentAt: 'lastSentAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.CustomerPushOrderScalarFieldEnum = {
  id: 'id',
  subscriptionId: 'subscriptionId',
  orderId: 'orderId',
  trackPath: 'trackPath',
  createdAt: 'createdAt'
};

exports.Prisma.ContractTemplateScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  name: 'name',
  description: 'description',
  bodyHtml: 'bodyHtml',
  fileUrl: 'fileUrl',
  fileName: 'fileName',
  fileType: 'fileType',
  subscriptionAmountPence: 'subscriptionAmountPence',
  createdByUserId: 'createdByUserId',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  deletedAt: 'deletedAt'
};

exports.Prisma.ContractScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  templateId: 'templateId',
  locationId: 'locationId',
  title: 'title',
  bodyHtml: 'bodyHtml',
  sourceHtml: 'sourceHtml',
  fileUrl: 'fileUrl',
  fileName: 'fileName',
  fileType: 'fileType',
  recipientName: 'recipientName',
  recipientEmail: 'recipientEmail',
  recipientCompany: 'recipientCompany',
  recipientCompanyNumber: 'recipientCompanyNumber',
  recipientAddress: 'recipientAddress',
  recipientPhone: 'recipientPhone',
  locationCount: 'locationCount',
  subscriptionAmountPence: 'subscriptionAmountPence',
  commissionPercent: 'commissionPercent',
  customerServiceChargePence: 'customerServiceChargePence',
  issuer: 'issuer',
  status: 'status',
  token: 'token',
  sentAt: 'sentAt',
  firstOpenedAt: 'firstOpenedAt',
  signedAt: 'signedAt',
  voidedAt: 'voidedAt',
  lastRemindedAt: 'lastRemindedAt',
  signerName: 'signerName',
  signerEmail: 'signerEmail',
  signatureImageUrl: 'signatureImageUrl',
  signerIp: 'signerIp',
  signerUserAgent: 'signerUserAgent',
  subscriptionStartedAt: 'subscriptionStartedAt',
  createdByUserId: 'createdByUserId',
  deletedAt: 'deletedAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.ContractEventScalarFieldEnum = {
  id: 'id',
  contractId: 'contractId',
  type: 'type',
  ip: 'ip',
  userAgent: 'userAgent',
  meta: 'meta',
  createdAt: 'createdAt'
};

exports.Prisma.LoyaltyCardScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  isActive: 'isActive',
  stampsRequired: 'stampsRequired',
  minimumSpend: 'minimumSpend',
  rewardItemId: 'rewardItemId',
  rewardLabel: 'rewardLabel',
  rewardExpiryDays: 'rewardExpiryDays',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.LoyaltyStampScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  cardId: 'cardId',
  customerAccountId: 'customerAccountId',
  orderId: 'orderId',
  spend: 'spend',
  createdAt: 'createdAt'
};

exports.Prisma.LoyaltyRewardScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  cardId: 'cardId',
  locationId: 'locationId',
  source: 'source',
  amountOff: 'amountOff',
  customerAccountId: 'customerAccountId',
  label: 'label',
  rewardItemId: 'rewardItemId',
  earnedAt: 'earnedAt',
  expiresAt: 'expiresAt',
  claimedAt: 'claimedAt',
  claimedOrderId: 'claimedOrderId'
};

exports.Prisma.ReferralProgramScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  isActive: 'isActive',
  referrerAmount: 'referrerAmount',
  friendAmount: 'friendAmount',
  minimumSpend: 'minimumSpend',
  maxPerCustomer: 'maxPerCustomer',
  rewardExpiryDays: 'rewardExpiryDays',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.ReferralCodeScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  programId: 'programId',
  customerAccountId: 'customerAccountId',
  code: 'code',
  createdAt: 'createdAt'
};

exports.Prisma.ReferralScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  programId: 'programId',
  codeId: 'codeId',
  referrerAccountId: 'referrerAccountId',
  friendAccountId: 'friendAccountId',
  friendPhone: 'friendPhone',
  status: 'status',
  rejectedReason: 'rejectedReason',
  verifyToken: 'verifyToken',
  verifiedPhone: 'verifiedPhone',
  verifiedAt: 'verifiedAt',
  qualifyingOrderId: 'qualifyingOrderId',
  qualifiedAt: 'qualifiedAt',
  createdAt: 'createdAt'
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

exports.Prisma.UserLocationOrderByRelevanceFieldEnum = {
  id: 'id',
  userId: 'userId',
  locationId: 'locationId'
};

exports.Prisma.UserBrandOrderByRelevanceFieldEnum = {
  id: 'id',
  userId: 'userId',
  brandId: 'brandId'
};

exports.Prisma.InvitationOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  email: 'email',
  locationIds: 'locationIds',
  brandIds: 'brandIds',
  token: 'token',
  invitedById: 'invitedById'
};

exports.Prisma.LeadOrderByRelevanceFieldEnum = {
  id: 'id',
  firstName: 'firstName',
  lastName: 'lastName',
  email: 'email',
  phone: 'phone',
  country: 'country',
  companyName: 'companyName',
  numberOfLocations: 'numberOfLocations',
  hearAboutUs: 'hearAboutUs',
  message: 'message',
  submittedByUserId: 'submittedByUserId',
  notes: 'notes'
};

exports.Prisma.CustomerAccountOrderByRelevanceFieldEnum = {
  id: 'id',
  email: 'email',
  password: 'password',
  firstName: 'firstName',
  lastName: 'lastName',
  phone: 'phone',
  googleId: 'googleId',
  avatarUrl: 'avatarUrl',
  emailVerificationToken: 'emailVerificationToken'
};

exports.Prisma.PasswordResetTokenOrderByRelevanceFieldEnum = {
  id: 'id',
  userId: 'userId',
  tokenHash: 'tokenHash',
  requestedIp: 'requestedIp',
  userAgent: 'userAgent'
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
  primaryLocationId: 'primaryLocationId',
  topSellerItemIds: 'topSellerItemIds',
  onlineOrderingSlug: 'onlineOrderingSlug',
  about: 'about',
  phone: 'phone',
  addressLine1: 'addressLine1',
  addressLine2: 'addressLine2',
  city: 'city',
  postcode: 'postcode',
  country: 'country',
  customDomain: 'customDomain',
  customDomainStatus: 'customDomainStatus',
  stripeConnectedAccountId: 'stripeConnectedAccountId',
  tapDestinationId: 'tapDestinationId',
  tapBusinessId: 'tapBusinessId',
  applicationFeeMode: 'applicationFeeMode',
  defaultStationId: 'defaultStationId'
};

exports.Prisma.LocationOrderByRelevanceFieldEnum = {
  id: 'id',
  brandId: 'brandId',
  name: 'name',
  externalRef: 'externalRef',
  phone: 'phone',
  timezone: 'timezone',
  defaultKitchenStationId: 'defaultKitchenStationId',
  receiptPrinterId: 'receiptPrinterId',
  dispatchPrinterId: 'dispatchPrinterId',
  addressLine1: 'addressLine1',
  addressLine2: 'addressLine2',
  city: 'city',
  postcode: 'postcode',
  country: 'country',
  currency: 'currency',
  about: 'about',
  logoUrl: 'logoUrl',
  customDomain: 'customDomain',
  customDomainStatus: 'customDomainStatus',
  onlineOrderingSlug: 'onlineOrderingSlug',
  hubriseCatalogId: 'hubriseCatalogId',
  hubriseLocationId: 'hubriseLocationId',
  stripeConnectedAccountId: 'stripeConnectedAccountId',
  applicationFeeMode: 'applicationFeeMode',
  posStripeAccountId: 'posStripeAccountId',
  status: 'status',
  googleReviewUrl: 'googleReviewUrl',
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

exports.Prisma.MenuChannelAssignmentOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  menuId: 'menuId',
  locationId: 'locationId',
  brandId: 'brandId',
  channel: 'channel',
  createdBy: 'createdBy'
};

exports.Prisma.BrandChannelSourceOrderByRelevanceFieldEnum = {
  id: 'id',
  brandId: 'brandId',
  channel: 'channel',
  sourceMenuId: 'sourceMenuId',
  variantRef: 'variantRef'
};

exports.Prisma.MenuCategoryOrderByRelevanceFieldEnum = {
  id: 'id',
  menuId: 'menuId',
  name: 'name',
  description: 'description',
  secondLanguageName: 'secondLanguageName',
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
  locationId: 'locationId',
  name: 'name',
  description: 'description',
  secondLanguageName: 'secondLanguageName',
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

exports.Prisma.ChannelPauseOrderByRelevanceFieldEnum = {
  id: 'id',
  locationId: 'locationId',
  brandId: 'brandId',
  channel: 'channel',
  mode: 'mode',
  reason: 'reason',
  pausedBy: 'pausedBy'
};

exports.Prisma.MenuItemChannelAvailabilityOrderByRelevanceFieldEnum = {
  id: 'id',
  itemId: 'itemId',
  channel: 'channel',
  locationId: 'locationId',
  snoozeReason: 'snoozeReason',
  snoozedBy: 'snoozedBy'
};

exports.Prisma.MenuItemOnCategoryOrderByRelevanceFieldEnum = {
  categoryId: 'categoryId',
  itemId: 'itemId'
};

exports.Prisma.ModifierGroupOrderByRelevanceFieldEnum = {
  id: 'id',
  brandId: 'brandId',
  locationId: 'locationId',
  name: 'name',
  description: 'description',
  secondLanguageName: 'secondLanguageName',
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
  secondLanguageName: 'secondLanguageName',
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

exports.Prisma.ModifierOptionNestedGroupOrderByRelevanceFieldEnum = {
  optionId: 'optionId',
  groupId: 'groupId'
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
  brandId: 'brandId',
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

exports.Prisma.MarketingCampaignOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  brandId: 'brandId',
  name: 'name',
  description: 'description',
  channels: 'channels',
  freeItemId: 'freeItemId',
  itemIds: 'itemIds',
  dailyStartTime: 'dailyStartTime',
  dailyEndTime: 'dailyEndTime',
  createdBy: 'createdBy'
};

exports.Prisma.CampaignRedemptionOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  campaignId: 'campaignId',
  brandId: 'brandId',
  orderId: 'orderId',
  channel: 'channel',
  customerAccountId: 'customerAccountId'
};

exports.Prisma.DeliveryZoneOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  brandId: 'brandId',
  postcodePrefix: 'postcodePrefix',
  areaName: 'areaName'
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
  customerAccountId: 'customerAccountId',
  brandId: 'brandId',
  externalId: 'externalId',
  displayId: 'displayId',
  deliveryType: 'deliveryType',
  courierName: 'courierName',
  courierPhone: 'courierPhone',
  courierPhoneAccessCode: 'courierPhoneAccessCode',
  courierTrackingUrl: 'courierTrackingUrl',
  courierStatus: 'courierStatus',
  courierProvider: 'courierProvider',
  courierJobId: 'courierJobId',
  tableId: 'tableId',
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

exports.Prisma.ActivityLogOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  brandId: 'brandId',
  category: 'category',
  channel: 'channel',
  action: 'action',
  status: 'status',
  message: 'message'
};

exports.Prisma.KdsScreenOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  name: 'name',
  station: 'station'
};

exports.Prisma.SignageDisplayOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  brandId: 'brandId',
  name: 'name',
  publicToken: 'publicToken',
  categoryIds: 'categoryIds',
  orientation: 'orientation'
};

exports.Prisma.TableOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  name: 'name',
  area: 'area',
  status: 'status',
  currentOrderId: 'currentOrderId',
  shape: 'shape',
  outOfServiceNote: 'outOfServiceNote',
  qrToken: 'qrToken',
  serverId: 'serverId',
  serverName: 'serverName'
};

exports.Prisma.KioskDeviceOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  brandId: 'brandId',
  name: 'name',
  publicToken: 'publicToken'
};

exports.Prisma.TableReservationOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  tableId: 'tableId',
  customerName: 'customerName',
  customerPhone: 'customerPhone',
  customerEmail: 'customerEmail',
  status: 'status',
  source: 'source',
  notes: 'notes',
  orderId: 'orderId',
  reference: 'reference'
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
  failoverPrinterId: 'failoverPrinterId',
  model: 'model',
  agentId: 'agentId'
};

exports.Prisma.PrintJobOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  printerId: 'printerId',
  orderId: 'orderId',
  error: 'error',
  stationId: 'stationId',
  claimedByAgentId: 'claimedByAgentId',
  routeKey: 'routeKey',
  idempotencyKey: 'idempotencyKey',
  failureReason: 'failureReason',
  lastError: 'lastError'
};

exports.Prisma.PrinterStationOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  name: 'name',
  defaultPrinterId: 'defaultPrinterId'
};

exports.Prisma.PrintAgentOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  name: 'name',
  apiTokenHash: 'apiTokenHash',
  versionString: 'versionString',
  deviceId: 'deviceId',
  deviceName: 'deviceName',
  osType: 'osType',
  hostname: 'hostname'
};

exports.Prisma.AlertConfigOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  stationId: 'stationId',
  soundUrl: 'soundUrl'
};

exports.Prisma.AlertAckOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  referenceKey: 'referenceKey',
  acknowledgedById: 'acknowledgedById'
};

exports.Prisma.AgentPairCodeOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  code: 'code',
  createdById: 'createdById',
  agentId: 'agentId'
};

exports.Prisma.MenuItemStationOrderByRelevanceFieldEnum = {
  id: 'id',
  menuItemId: 'menuItemId',
  stationId: 'stationId'
};

exports.Prisma.ModifierGroupStationOrderByRelevanceFieldEnum = {
  id: 'id',
  modifierGroupId: 'modifierGroupId',
  stationId: 'stationId'
};

exports.Prisma.MenuCategoryStationOrderByRelevanceFieldEnum = {
  id: 'id',
  categoryId: 'categoryId',
  stationId: 'stationId'
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
  vehicleType: 'vehicleType',
  locationId: 'locationId'
};

exports.Prisma.DriverCashUpOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  driverId: 'driverId',
  locationId: 'locationId',
  createdBy: 'createdBy'
};

exports.Prisma.DriverPresenceOrderByRelevanceFieldEnum = {
  id: 'id',
  driverId: 'driverId',
  tenantId: 'tenantId',
  locationId: 'locationId',
  activeAssignmentId: 'activeAssignmentId',
  socketId: 'socketId',
  pushToken: 'pushToken'
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

exports.Prisma.ChatMessageOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  channel: 'channel',
  driverId: 'driverId',
  orderId: 'orderId',
  senderType: 'senderType',
  senderName: 'senderName',
  body: 'body'
};

exports.Prisma.WhatsAppConversationOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  brandId: 'brandId',
  waPhone: 'waPhone',
  phoneNumberId: 'phoneNumberId',
  state: 'state',
  customerName: 'customerName',
  lastOrderId: 'lastOrderId'
};

exports.Prisma.StripeConnectAccountOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  brandId: 'brandId',
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
  provider: 'provider',
  providerChargeId: 'providerChargeId',
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

exports.Prisma.MerchantSubscriptionOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  stripeCustomerId: 'stripeCustomerId',
  stripeSubscriptionId: 'stripeSubscriptionId',
  stripePriceId: 'stripePriceId',
  stripeCheckoutId: 'stripeCheckoutId',
  currency: 'currency',
  status: 'status',
  defaultPaymentBrand: 'defaultPaymentBrand',
  defaultPaymentLast4: 'defaultPaymentLast4',
  lastInvoiceStatus: 'lastInvoiceStatus',
  lastFailureMessage: 'lastFailureMessage'
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

exports.Prisma.SystemSecretOrderByRelevanceFieldEnum = {
  id: 'id',
  key: 'key',
  label: 'label',
  description: 'description',
  category: 'category',
  encryptedValue: 'encryptedValue',
  lastFourChars: 'lastFourChars',
  createdBy: 'createdBy',
  updatedBy: 'updatedBy'
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

exports.Prisma.VideoStudioAccountOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  stripeSubscriptionId: 'stripeSubscriptionId'
};

exports.Prisma.VideoCreditTxnOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  source: 'source',
  generationId: 'generationId',
  note: 'note'
};

exports.Prisma.VideoGenerationOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  userId: 'userId',
  locationId: 'locationId',
  brandId: 'brandId',
  kind: 'kind',
  model: 'model',
  prompt: 'prompt',
  sourceImageUrl: 'sourceImageUrl',
  resultUrl: 'resultUrl',
  replicatePredictionId: 'replicatePredictionId',
  error: 'error'
};

exports.Prisma.SmsMessageOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  brandId: 'brandId',
  orderId: 'orderId',
  toNumber: 'toNumber',
  purpose: 'purpose',
  campaignId: 'campaignId',
  provider: 'provider',
  providerSid: 'providerSid',
  status: 'status',
  error: 'error',
  createdBy: 'createdBy'
};

exports.Prisma.MarketingContactOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  phone: 'phone',
  firstName: 'firstName',
  lastName: 'lastName',
  email: 'email',
  source: 'source',
  customerId: 'customerId',
  consentStatus: 'consentStatus',
  consentSource: 'consentSource',
  tags: 'tags',
  createdBy: 'createdBy'
};

exports.Prisma.MarketingSmsCampaignOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  name: 'name',
  senderHeader: 'senderHeader',
  body: 'body',
  status: 'status',
  createdBy: 'createdBy'
};

exports.Prisma.MarketingSmsRecipientOrderByRelevanceFieldEnum = {
  id: 'id',
  campaignId: 'campaignId',
  tenantId: 'tenantId',
  contactId: 'contactId',
  phone: 'phone',
  status: 'status',
  reason: 'reason',
  smsMessageId: 'smsMessageId'
};

exports.Prisma.WalletOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  currency: 'currency',
  stripeCustomerId: 'stripeCustomerId',
  stripePaymentMethodId: 'stripePaymentMethodId',
  autoTopupFailureReason: 'autoTopupFailureReason'
};

exports.Prisma.WalletTransactionOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  walletId: 'walletId',
  type: 'type',
  currency: 'currency',
  purpose: 'purpose',
  smsMessageId: 'smsMessageId',
  orderId: 'orderId',
  voiceCallId: 'voiceCallId',
  locationId: 'locationId',
  stripeCheckoutId: 'stripeCheckoutId',
  stripePaymentIntentId: 'stripePaymentIntentId',
  description: 'description',
  createdBy: 'createdBy'
};

exports.Prisma.StuartConfigOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  environment: 'environment',
  webhookAuthKey: 'webhookAuthKey'
};

exports.Prisma.UberDirectConfigOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  environment: 'environment'
};

exports.Prisma.ReviewOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  orderId: 'orderId',
  locationId: 'locationId',
  brandId: 'brandId',
  customerId: 'customerId',
  customerName: 'customerName',
  comment: 'comment',
  status: 'status',
  reply: 'reply',
  repliedBy: 'repliedBy'
};

exports.Prisma.VoiceCallOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  brandId: 'brandId',
  providerCallId: 'providerCallId',
  provider: 'provider',
  fromNumber: 'fromNumber',
  toNumber: 'toNumber',
  direction: 'direction',
  status: 'status',
  notAnsweredReason: 'notAnsweredReason',
  outcome: 'outcome',
  orderId: 'orderId',
  reservationId: 'reservationId'
};

exports.Prisma.GroupOrderOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  token: 'token',
  locationId: 'locationId',
  brandId: 'brandId',
  hostCustomerId: 'hostCustomerId',
  hostName: 'hostName',
  hostRef: 'hostRef',
  status: 'status',
  orderId: 'orderId',
  fulfillmentType: 'fulfillmentType',
  paymentMode: 'paymentMode'
};

exports.Prisma.GroupOrderItemOrderByRelevanceFieldEnum = {
  id: 'id',
  groupOrderId: 'groupOrderId',
  addedByName: 'addedByName',
  addedByRef: 'addedByRef',
  paymentId: 'paymentId'
};

exports.Prisma.CustomerPushSubscriptionOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  brandId: 'brandId',
  endpoint: 'endpoint',
  p256dh: 'p256dh',
  auth: 'auth',
  customerId: 'customerId',
  deviceRef: 'deviceRef',
  userAgent: 'userAgent'
};

exports.Prisma.CustomerPushOrderOrderByRelevanceFieldEnum = {
  id: 'id',
  subscriptionId: 'subscriptionId',
  orderId: 'orderId',
  trackPath: 'trackPath'
};

exports.Prisma.ContractTemplateOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  name: 'name',
  description: 'description',
  bodyHtml: 'bodyHtml',
  fileUrl: 'fileUrl',
  fileName: 'fileName',
  fileType: 'fileType',
  createdByUserId: 'createdByUserId'
};

exports.Prisma.ContractOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  templateId: 'templateId',
  locationId: 'locationId',
  title: 'title',
  bodyHtml: 'bodyHtml',
  sourceHtml: 'sourceHtml',
  fileUrl: 'fileUrl',
  fileName: 'fileName',
  fileType: 'fileType',
  recipientName: 'recipientName',
  recipientEmail: 'recipientEmail',
  recipientCompany: 'recipientCompany',
  recipientCompanyNumber: 'recipientCompanyNumber',
  recipientAddress: 'recipientAddress',
  recipientPhone: 'recipientPhone',
  status: 'status',
  token: 'token',
  signerName: 'signerName',
  signerEmail: 'signerEmail',
  signatureImageUrl: 'signatureImageUrl',
  signerIp: 'signerIp',
  signerUserAgent: 'signerUserAgent',
  createdByUserId: 'createdByUserId'
};

exports.Prisma.ContractEventOrderByRelevanceFieldEnum = {
  id: 'id',
  contractId: 'contractId',
  type: 'type',
  ip: 'ip',
  userAgent: 'userAgent'
};

exports.Prisma.LoyaltyCardOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId',
  rewardItemId: 'rewardItemId',
  rewardLabel: 'rewardLabel'
};

exports.Prisma.LoyaltyStampOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  cardId: 'cardId',
  customerAccountId: 'customerAccountId',
  orderId: 'orderId'
};

exports.Prisma.LoyaltyRewardOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  cardId: 'cardId',
  locationId: 'locationId',
  source: 'source',
  customerAccountId: 'customerAccountId',
  label: 'label',
  rewardItemId: 'rewardItemId',
  claimedOrderId: 'claimedOrderId'
};

exports.Prisma.ReferralProgramOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  locationId: 'locationId'
};

exports.Prisma.ReferralCodeOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  programId: 'programId',
  customerAccountId: 'customerAccountId',
  code: 'code'
};

exports.Prisma.ReferralOrderByRelevanceFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  programId: 'programId',
  codeId: 'codeId',
  referrerAccountId: 'referrerAccountId',
  friendAccountId: 'friendAccountId',
  friendPhone: 'friendPhone',
  status: 'status',
  rejectedReason: 'rejectedReason',
  verifyToken: 'verifyToken',
  verifiedPhone: 'verifiedPhone',
  qualifyingOrderId: 'qualifyingOrderId'
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
  VIEWER: 'VIEWER',
  OWNER: 'OWNER',
  DARK_KITCHEN_MANAGER: 'DARK_KITCHEN_MANAGER',
  STAFF: 'STAFF',
  ONBOARDING_AGENT: 'ONBOARDING_AGENT',
  FINANCIAL_AGENT: 'FINANCIAL_AGENT',
  KIOSK: 'KIOSK',
  KITCHEN_DISPLAY: 'KITCHEN_DISPLAY'
};

exports.LeadSource = exports.$Enums.LeadSource = {
  NO_ACCESS_SCREEN: 'NO_ACCESS_SCREEN',
  MARKETING_SITE: 'MARKETING_SITE',
  OTHER: 'OTHER'
};

exports.LeadStatus = exports.$Enums.LeadStatus = {
  NEW: 'NEW',
  CONTACTED: 'CONTACTED',
  QUALIFIED: 'QUALIFIED',
  WON: 'WON',
  LOST: 'LOST'
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
  CAREEM: 'CAREEM',
  WHATSAPP: 'WHATSAPP'
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

exports.CampaignType = exports.$Enums.CampaignType = {
  PERCENTAGE_OFF: 'PERCENTAGE_OFF',
  AMOUNT_OFF_ORDER: 'AMOUNT_OFF_ORDER',
  PERCENT_OFF_ITEMS: 'PERCENT_OFF_ITEMS',
  BOGO: 'BOGO',
  FREE_ITEM: 'FREE_ITEM',
  FREE_DELIVERY: 'FREE_DELIVERY',
  HAPPY_HOUR: 'HAPPY_HOUR'
};

exports.CampaignStatus = exports.$Enums.CampaignStatus = {
  DRAFT: 'DRAFT',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  ENDED: 'ENDED'
};

exports.CampaignAudience = exports.$Enums.CampaignAudience = {
  ALL: 'ALL',
  NEW: 'NEW',
  RETURNING: 'RETURNING',
  LAPSED: 'LAPSED'
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
  CAREEM: 'CAREEM',
  WHATSAPP: 'WHATSAPP',
  VOICE: 'VOICE'
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
  CAREEM: 'CAREEM',
  WHATSAPP: 'WHATSAPP',
  VOICE: 'VOICE'
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
  RIDER_ARRIVED: 'RIDER_ARRIVED',
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
  AUTHORIZED: 'AUTHORIZED',
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

exports.PrinterStationKind = exports.$Enums.PrinterStationKind = {
  KITCHEN: 'KITCHEN',
  FRONT_COUNTER: 'FRONT_COUNTER',
  BAR: 'BAR',
  LABELS: 'LABELS',
  DISPATCH: 'DISPATCH',
  EXPO: 'EXPO',
  OTHER: 'OTHER'
};

exports.PrintJobType = exports.$Enums.PrintJobType = {
  RECEIPT: 'RECEIPT',
  DRIVER_RECEIPT: 'DRIVER_RECEIPT',
  KITCHEN_TICKET: 'KITCHEN_TICKET',
  LABEL: 'LABEL',
  CANCEL_TICKET: 'CANCEL_TICKET',
  REPRINT: 'REPRINT',
  EOD_REPORT: 'EOD_REPORT',
  CUSTOMER_RECEIPT: 'CUSTOMER_RECEIPT',
  DRIVER_SLIP: 'DRIVER_SLIP',
  DISPATCH_TICKET: 'DISPATCH_TICKET',
  TEST_PRINT: 'TEST_PRINT'
};

exports.PrintJobStatus = exports.$Enums.PrintJobStatus = {
  QUEUED: 'QUEUED',
  CLAIMED: 'CLAIMED',
  PRINTING: 'PRINTING',
  PRINTED: 'PRINTED',
  FAILED: 'FAILED',
  RETRYING: 'RETRYING'
};

exports.PrintTrigger = exports.$Enums.PrintTrigger = {
  ORDER_RECEIVED: 'ORDER_RECEIVED',
  ORDER_ACCEPTED: 'ORDER_ACCEPTED',
  ORDER_PREPARING: 'ORDER_PREPARING',
  ORDER_READY: 'ORDER_READY',
  MANUAL_ONLY: 'MANUAL_ONLY'
};

exports.PrintAgentKind = exports.$Enums.PrintAgentKind = {
  WEB_BRIDGE: 'WEB_BRIDGE',
  FLUTTER_MOBILE: 'FLUTTER_MOBILE',
  FLUTTER_DESKTOP: 'FLUTTER_DESKTOP',
  SERVER_DIRECT: 'SERVER_DIRECT'
};

exports.AlertTrigger = exports.$Enums.AlertTrigger = {
  NEW_ORDER: 'NEW_ORDER',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  RIDER_ARRIVED: 'RIDER_ARRIVED',
  SCHEDULED_ORDER_READY: 'SCHEDULED_ORDER_READY',
  PRINTER_OFFLINE: 'PRINTER_OFFLINE',
  FAILED_PRINT: 'FAILED_PRINT'
};

exports.DriverPresenceStatus = exports.$Enums.DriverPresenceStatus = {
  OFFLINE: 'OFFLINE',
  ONLINE: 'ONLINE',
  ON_JOB: 'ON_JOB'
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

exports.VideoCreditReason = exports.$Enums.VideoCreditReason = {
  GRANT: 'GRANT',
  TOPUP: 'TOPUP',
  DEBIT: 'DEBIT',
  REFUND: 'REFUND',
  ADJUST: 'ADJUST'
};

exports.VideoGenStatus = exports.$Enums.VideoGenStatus = {
  QUEUED: 'QUEUED',
  RENDERING: 'RENDERING',
  READY: 'READY',
  FAILED: 'FAILED'
};

exports.Prisma.ModelName = {
  Tenant: 'Tenant',
  User: 'User',
  UserLocation: 'UserLocation',
  UserBrand: 'UserBrand',
  Invitation: 'Invitation',
  Lead: 'Lead',
  CustomerAccount: 'CustomerAccount',
  PasswordResetToken: 'PasswordResetToken',
  RefreshToken: 'RefreshToken',
  OAuthAccount: 'OAuthAccount',
  ApiKey: 'ApiKey',
  AuditLog: 'AuditLog',
  Brand: 'Brand',
  Location: 'Location',
  BrandPlatformConnection: 'BrandPlatformConnection',
  Integration: 'Integration',
  Menu: 'Menu',
  MenuChannelAssignment: 'MenuChannelAssignment',
  BrandChannelSource: 'BrandChannelSource',
  MenuCategory: 'MenuCategory',
  MenuItem: 'MenuItem',
  ChannelPause: 'ChannelPause',
  MenuItemChannelAvailability: 'MenuItemChannelAvailability',
  MenuItemOnCategory: 'MenuItemOnCategory',
  ModifierGroup: 'ModifierGroup',
  ModifierOption: 'ModifierOption',
  ModifierOptionNestedGroup: 'ModifierOptionNestedGroup',
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
  MarketingCampaign: 'MarketingCampaign',
  CampaignRedemption: 'CampaignRedemption',
  DeliveryZone: 'DeliveryZone',
  LocationPaymentConfig: 'LocationPaymentConfig',
  Order: 'Order',
  OrderNumberSequence: 'OrderNumberSequence',
  OrderItem: 'OrderItem',
  OrderStatusHistory: 'OrderStatusHistory',
  WebhookEvent: 'WebhookEvent',
  ActivityLog: 'ActivityLog',
  KdsScreen: 'KdsScreen',
  SignageDisplay: 'SignageDisplay',
  Table: 'Table',
  KioskDevice: 'KioskDevice',
  TableReservation: 'TableReservation',
  KdsTicket: 'KdsTicket',
  Printer: 'Printer',
  PrintJob: 'PrintJob',
  PrinterStation: 'PrinterStation',
  PrintAgent: 'PrintAgent',
  AlertConfig: 'AlertConfig',
  AlertAck: 'AlertAck',
  AgentPairCode: 'AgentPairCode',
  MenuItemStation: 'MenuItemStation',
  ModifierGroupStation: 'ModifierGroupStation',
  MenuCategoryStation: 'MenuCategoryStation',
  PrintTemplate: 'PrintTemplate',
  Driver: 'Driver',
  DriverCashUp: 'DriverCashUp',
  DriverPresence: 'DriverPresence',
  DriverAssignment: 'DriverAssignment',
  DeliveryTracking: 'DeliveryTracking',
  ChatMessage: 'ChatMessage',
  WhatsAppConversation: 'WhatsAppConversation',
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
  MerchantSubscription: 'MerchantSubscription',
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
  SystemSecret: 'SystemSecret',
  OutboxEvent: 'OutboxEvent',
  VideoStudioAccount: 'VideoStudioAccount',
  VideoCreditTxn: 'VideoCreditTxn',
  VideoGeneration: 'VideoGeneration',
  SmsMessage: 'SmsMessage',
  MarketingContact: 'MarketingContact',
  MarketingSmsCampaign: 'MarketingSmsCampaign',
  MarketingSmsRecipient: 'MarketingSmsRecipient',
  Wallet: 'Wallet',
  WalletTransaction: 'WalletTransaction',
  StuartConfig: 'StuartConfig',
  UberDirectConfig: 'UberDirectConfig',
  Review: 'Review',
  VoiceCall: 'VoiceCall',
  GroupOrder: 'GroupOrder',
  GroupOrderItem: 'GroupOrderItem',
  CustomerPushSubscription: 'CustomerPushSubscription',
  CustomerPushOrder: 'CustomerPushOrder',
  ContractTemplate: 'ContractTemplate',
  Contract: 'Contract',
  ContractEvent: 'ContractEvent',
  LoyaltyCard: 'LoyaltyCard',
  LoyaltyStamp: 'LoyaltyStamp',
  LoyaltyReward: 'LoyaltyReward',
  ReferralProgram: 'ReferralProgram',
  ReferralCode: 'ReferralCode',
  Referral: 'Referral'
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
