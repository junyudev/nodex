export interface FileOpenApplication {
  name: string;
  appPath: string;
  iconDataUrl: string | null;
}

export interface FileOpenApplicationsInput {
  path: string;
}

export interface FileOpenApplicationsResult {
  defaultApplication: FileOpenApplication | null;
  applications: FileOpenApplication[];
}

export interface OpenFileWithApplicationInput extends FileOpenApplicationsInput {
  appPath: string;
}
