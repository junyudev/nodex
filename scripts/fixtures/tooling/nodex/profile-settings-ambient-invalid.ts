import { homedir } from "node:os";

export const ambientSettingsAuthority = {
  cwd: process.cwd(),
  environment: process.env,
  home: homedir(),
};
