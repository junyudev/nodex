import path from "node:path";

/** fs/readFile has no bounded-read contract. Keep limits on the source host before transport. */
export function workspaceFileReadCommand(
  filePath: string,
  sampleBytes: number,
  maxFileBytes?: number,
): string[] {
  if (path.win32.isAbsolute(filePath) && !path.posix.isAbsolute(filePath)) {
    const literalPath = `'${filePath.replaceAll("'", "''")}'`;
    const script = `$ErrorActionPreference='Stop'; $f=[IO.File]::OpenRead(${literalPath}); try {
      [Console]::Out.WriteLine($f.Length);
      if ($f.Length -gt ${maxFileBytes ?? Number.MAX_SAFE_INTEGER}) { exit 0 }
      $b=New-Object byte[] ${sampleBytes}; $n=0;
      while ($n -lt $b.Length) { $r=$f.Read($b,$n,$b.Length-$n); if ($r -eq 0) { break }; $n+=$r }
      [Console]::Out.Write([Convert]::ToBase64String($b,0,$n))
    } finally { $f.Dispose() }`;
    return [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ];
  }
  return [
    "sh",
    "-c",
    'exec 3< "$1" || exit; size=$(stat -L -c %s "$1" 2>/dev/null || stat -L -f %z "$1") || exit; printf "%s\\n" "$size"; [ "$size" -le "$3" ] || exit 0; head -c "$2" <&3 | base64',
    "nodex-file-read",
    filePath,
    String(sampleBytes),
    String(maxFileBytes ?? Number.MAX_SAFE_INTEGER),
  ];
}
