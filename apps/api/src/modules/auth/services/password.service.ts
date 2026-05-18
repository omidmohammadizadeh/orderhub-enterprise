import { Injectable } from "@nestjs/common";
import * as bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 12;

// Minimum password strength requirements for the platform.
// Applied on registration and password change — not on login
// (to avoid leaking whether an account exists).
export interface PasswordStrengthResult {
  valid: boolean;
  errors: string[];
}

@Injectable()
export class PasswordService {
  async hash(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
  }

  async compare(plaintext: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plaintext, hash);
  }

  // Called during registration / password change — never during login.
  // Deliberately kept simple; add zxcvbn or similar for stronger entropy checks.
  validateStrength(password: string): PasswordStrengthResult {
    const errors: string[] = [];

    if (password.length < 8) errors.push("Must be at least 8 characters");
    if (password.length > 128) errors.push("Must be at most 128 characters");
    if (!/[A-Z]/.test(password)) errors.push("Must contain an uppercase letter");
    if (!/[a-z]/.test(password)) errors.push("Must contain a lowercase letter");
    if (!/\d/.test(password)) errors.push("Must contain a number");

    return { valid: errors.length === 0, errors };
  }
}
