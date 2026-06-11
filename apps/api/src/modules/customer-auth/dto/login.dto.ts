import { IsEmail, IsString } from "class-validator";

export class CustomerLoginDto {
  @IsEmail()
  email!: string;

  // We deliberately don't run strength validation on login — that would
  // leak whether the account exists when invalid passwords get rejected
  // for different reasons.
  @IsString()
  password!: string;
}
