import {EventEmitter} from "events";

export interface IDeviceSubtypeManager extends EventEmitter {
  StartScanning(): void;
  StopScanning(): void;
  IsScanning(): void;
}
