import type { CreateTRPCReact } from "@trpc/react-query";
import { createTRPCReact } from "@trpc/react-query";
import type { CoreRouter } from "../src/api";

export const trpc: CreateTRPCReact<CoreRouter, unknown> = createTRPCReact<CoreRouter>();
