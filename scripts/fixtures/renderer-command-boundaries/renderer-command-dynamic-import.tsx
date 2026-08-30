export function DynamicCommandPanel() {
  const loadTransport = () => import("@/lib/renderer-command");
  return <button onClick={() => void loadTransport()}>Run</button>;
}
