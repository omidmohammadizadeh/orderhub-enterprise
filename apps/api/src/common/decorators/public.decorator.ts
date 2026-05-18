import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";

// Mark a route or controller as public (no JWT required).
// JwtAuthGuard checks for this before running Passport.
// @Public() is preferable to removing @UseGuards(JwtAuthGuard) because
// the global guard registered in AppModule still runs and handles audit context.
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
