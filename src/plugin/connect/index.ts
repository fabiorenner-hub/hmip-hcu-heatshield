/**
 * Heat Shield — Connect API barrel module.
 *
 * Re-exports the public surface of the Connect API client so the rest
 * of the codebase can import from a single canonical path:
 *
 *   import { ConnectClient, type ConnectEnvelope } from '../connect/index.js';
 *
 * Sibling module `hmipSystem.ts` will be added by Task 6.5 and
 * re-exported here at that point. Currently exposed: `client.ts`
 * (Task 6.1), `envelope.ts` (Task 6.2), `discover.ts` (Task 6.3),
 * and `ownDevices.ts` (Task 6.4).
 */

export {
  ConnectClient,
  WS_CLOSED,
  WS_CLOSING,
  WS_CONNECTING,
  WS_OPEN,
} from './client.js';
export type {
  BackoffOptions,
  ConnectClientOptions,
  ConnectEnvelope,
  ConnectLogger,
  WebSocketFactory,
  WebSocketLike,
} from './client.js';

export {
  ConfigUpdateResponseStatus,
  PluginMessageType,
  PluginReadinessStatus,
  PropertyDataType,
  buildConfigTemplateResponse,
  buildConfigUpdateResponse,
  buildEnvelope,
  buildErrorResponse,
  buildPluginStateResponse,
  buildReply,
  isPluginMessageType,
  newMessageId,
} from './envelope.js';
export type {
  ConfigGroupTemplate,
  ConfigPropertyTemplate,
  ConfigUpdateResponseStatusValue,
  PluginMessageTypeName,
  PluginReadinessStatusValue,
  PropertyDataTypeValue,
} from './envelope.js';

export {
  HEAT_SHIELD_FIRMWARE_VERSION,
  HEAT_SHIELD_MODEL_TYPE,
  OWN_DEVICE_FRIENDLY_NAMES,
  buildDiscoverResponse,
  buildOwnDeviceDescriptors,
} from './discover.js';
export type {
  MaintenanceFeature,
  OwnDeviceDescriptor,
  OwnDeviceFeature,
  SourceHealthSnapshot,
  SwitchStateFeature,
} from './discover.js';

export { OwnDeviceManager } from './ownDevices.js';
export type {
  OwnDeviceManagerOptions,
  OwnDeviceUserInput,
} from './ownDevices.js';

export { HmipSystemAdapter } from './hmipSystem.js';
export type {
  HmipSystemAdapterOptions,
  ManualOverrideDetection,
  ShutterCommand,
} from './hmipSystem.js';
