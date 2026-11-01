/* @effect-diagnostics asyncFunction:off newPromise:off -- Native filesystem permissions are a Node Adapter boundary. */
import { chmod } from "node:fs/promises";
import { execFile } from "node:child_process";

/** Secure private files and inheritable directories with the native permission model. */
export const makePrivate = async (filename: string, directory: boolean): Promise<void> => {
  if (process.platform !== "win32") return chmod(filename, directory ? 0o700 : 0o600);
  const script = `$ErrorActionPreference='Stop'; $p=$env:NODEX_PRIVATE_PATH; $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent(); $sid=$identity.User; $acl=Get-Acl -LiteralPath $p; $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; if ($owner -ne $sid.Value -and $owner -ne $identity.Owner.Value) { throw 'Private filesystem entry has a different owner' }; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }; $inherit=if ($env:NODEX_PRIVATE_DIRECTORY -eq 'true') { 'ContainerInherit,ObjectInherit' } else { 'None' }; $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$inherit,'None','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl`;
  await new Promise<void>((resolve, reject) =>
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        env: {
          // PowerShell 7's inherited module path can shadow Windows PowerShell's own modules.
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"),
          ),
          NODEX_PRIVATE_PATH: filename,
          NODEX_PRIVATE_DIRECTORY: String(directory),
        },
      },
      (error) => (error ? reject(error) : resolve()),
    ),
  );
};
