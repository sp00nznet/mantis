#!/usr/bin/env node
/**
 * Thin wrapper — the bridge engine lives in src/approval-bridge.js so it can
 * also be reached via `mantis approval-bridge` (which works inside the
 * single-exe SEA build). This standalone entry remains for dev / explicit-node
 * launches. See src/approval-bridge.js for the protocol.
 */
import { runApprovalBridge } from '../src/approval-bridge.js';
runApprovalBridge();
