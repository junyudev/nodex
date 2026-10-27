export interface FileOpenApplication {
  name: string;
  appPath: string;
  iconDataUrl: string | null;
}

export interface FileOpenApplicationsInput {
  path: string;
}

export interface FileOpenApplicationsResult {
  /** The app a file opens in by default: its type's well-known viewer when installed, else the system default. */
  defaultApplication: FileOpenApplication | null;
  /** Other apps that can open the file, in system order. */
  applications: FileOpenApplication[];
}

export interface OpenFileWithApplicationInput extends FileOpenApplicationsInput {
  appPath: string;
}
