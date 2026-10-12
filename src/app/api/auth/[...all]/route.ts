import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth/servidor";

export const { GET, POST } = toNextJsHandler(auth);
