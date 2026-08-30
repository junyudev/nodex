import { invokePlainCommandWithTrace } from "@/lib/renderer-command";

export const TracedLeafCommand = () => {
  void invokePlainCommandWithTrace;
  return <div />;
};
