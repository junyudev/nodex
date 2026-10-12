import { ChildProcess } from "effect/process";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import * as SchemaCompiler from "effect/schema/SchemaCompiler";

void ChildProcess;
void SchemaCompiler;
export type Interrupt = RpcMessage.ExitEncoded;
