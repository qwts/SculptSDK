// Browser entry: bundled to an IIFE by scripts/build-kernel.mjs and injected
// once per page by runtime adapters. Network observation stays off until the
// operator's authority settings enable it via the `configure` op.
import { createKernel, type AnyWindow } from "./index.js";

createKernel(window as unknown as AnyWindow, { networkObservation: false });
