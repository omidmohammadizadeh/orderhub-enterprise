// Metadata attached to every auth action for audit logging.
// Extracted from the raw Express request — never user-supplied.
export interface RequestMeta {
  ipAddress: string;
  userAgent: string;
}
