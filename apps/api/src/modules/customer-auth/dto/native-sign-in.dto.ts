import { IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

/**
 * Sign-in from a restaurant's own app: the ID token the native Google or
 * Apple SDK handed it. Google blocks its OAuth page inside the app's WebView,
 * so the app signs in natively and gives the storefront the session we return.
 */
export class CustomerNativeSignInDto {
  @IsIn(["google", "apple"])
  provider!: "google" | "apple";

  @IsString()
  @MinLength(20)
  idToken!: string;

  /**
   * Apple sends the person's name to the app on the FIRST sign-in only, and
   * never in the token. Ignored for Google, whose token carries it.
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  /** The app's brand — logged, so a failing app is easy to spot. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  brandId?: string;
}
