/*!
 * Buttplug JS Source Code File - Visit https://buttplug.io for more info about
 * the project. Licensed under the BSD 3-Clause license. See LICENSE file in the
 * project root for full license information.
 *
 * @copyright Copyright (c) Nonpolynomial Labs LLC. All rights reserved.
 */

import * as Messages from "../core/Messages";
import { IButtplugDevice } from "../devices/IButtplugDevice";
import { IDeviceSubtypeManager } from "./IDeviceSubtypeManager";
import { WebBluetoothDeviceManager } from "./managers/webbluetooth/WebBluetoothDeviceManager";
import { EventEmitter } from "events";
import { ButtplugLogger } from "../core/Logging";
import { ButtplugException, ButtplugDeviceException, ButtplugMessageException } from "../core/Exceptions";
import { DeviceConfigurationManager } from "../devices/configuration/DeviceConfigurationManager";

export class DeviceManager extends EventEmitter {
  private _subtypeManagers: IDeviceSubtypeManager[] = [];
  private _devices: Map<number, IButtplugDevice> = new Map<number, IButtplugDevice>();
  private _deviceCounter: number = 0;
  private _logger = ButtplugLogger.Logger;
  private _msgClosure: (aMsg: Messages.ButtplugMessage) => void;

  constructor(aMsgClosure: (aMsg: Messages.ButtplugMessage) => void) {
    super();
    this._logger.Debug("DeviceManager: Starting Device Manager");
    try {
      // If getting this throws, it means we should just load the internal file.
      //
      // tslint:disable:no-unused-expression
      DeviceConfigurationManager.Manager;
    } catch (e) {
      DeviceConfigurationManager.LoadFromInternalConfig();
    }

    // If we have a bluetooth object on navigator, load the device manager
    if (typeof(window) !== "undefined" &&
        typeof(window.navigator) !== "undefined" &&
        (navigator as any).bluetooth) {
      this.AddDeviceManager(new WebBluetoothDeviceManager(this._logger));
    } else {
      this._logger.Info("DeviceManager: Not adding WebBluetooth Manager, no WebBluetooth capabilities found.");
    }
    this._msgClosure = aMsgClosure;
  }

  public get DeviceManagers(): IDeviceSubtypeManager[] {
    return this._subtypeManagers;
  }

  public Shutdown = async () => {
    for (const d of this._devices.values()) {
      await d.Disconnect();
    }
  }

  public ClearDeviceManagers = () => {
    this._logger.Info("DeviceManager: Clearing device subtype managers");
    this._subtypeManagers = [];
  }

  public AddDeviceManager = (aManager: IDeviceSubtypeManager) => {
    this._logger.Info(`DeviceManager: Adding Device Manager ${aManager.constructor.name}`);
    aManager.SetLogger(this._logger);
    this._subtypeManagers.push(aManager);
    aManager.addListener("deviceadded", this.OnDeviceAdded);
    // TODO why is this listening for remove? Managers never emit that.
    aManager.addListener("deviceremoved", this.OnDeviceRemoved);
    aManager.addListener("scanningfinished", this.OnScanningFinished);
  }

  public SendMessage = async (aMessage: Messages.ButtplugMessage): Promise<Messages.ButtplugMessage> => {
    const id = aMessage.Id;
    // We need to switch on type here, since using constructor would cause
    // issues with how we do message versioning.
    switch (aMessage.Type) {
      case Messages.StartScanning:
        this._logger.Debug(`DeviceManager: Starting scan`);
        if (this._subtypeManagers.length === 0) {
          // If we have no managers by this point, return an error, because we'll
          // have nothing to scan with.
          throw ButtplugException.LogAndError(ButtplugDeviceException,
                                              this._logger,
                                              "No device managers available, cannot scan.",
                                              id);
        }
        for (const manager of this._subtypeManagers) {
          if (!manager.IsScanning) {
            try {
              await manager.StartScanning();
            } catch (e) {
              // Something is wrong. Stop all other managers and rethrow.
              // TODO Should this only fail on the bad manager, or all managers?
              for (const mgr of this._subtypeManagers) {
                if (mgr.IsScanning) {
                  mgr.StopScanning();
                }
              }
              throw e;
            }
          }
        }
        return new Messages.Ok(id);
      case Messages.StopScanning:
        this._logger.Debug(`DeviceManager: Stopping scan`);
        for (const manager of this._subtypeManagers) {
          if (manager.IsScanning) {
            manager.StopScanning();
          }
        }
        return new Messages.Ok(id);
      case Messages.StopAllDevices:
        this._logger.Debug(`DeviceManager: Stopping all devices`);
        this._devices.forEach(async (deviceObj, index) => {
          // TODO What if something throws here?!
          await deviceObj.ParseMessage(new Messages.StopDeviceCmd());
        });
        return new Messages.Ok(id);
      case Messages.RequestDeviceList:
        this._logger.Debug(`DeviceManager: Sending device list`);
        const devices: Messages.DeviceInfoWithSpecifications[] = [];
        this._devices.forEach((v: IButtplugDevice, k: number) => {
          devices.push(new Messages.DeviceInfoWithSpecifications(k, v.Name, v.MessageSpecifications));
        });
        return new Messages.DeviceList(devices, id);
    }
    const deviceMsg = (aMessage as Messages.ButtplugDeviceMessage);
    if (deviceMsg.DeviceIndex === undefined) {
      throw ButtplugException.LogAndError(ButtplugMessageException,
                                          this._logger,
                                          `Message Type ${aMessage.Type} unhandled by this server.`,
                                          id);
    }
    if (!this._devices.has(deviceMsg.DeviceIndex)) {
      throw ButtplugException.LogAndError(ButtplugDeviceException,
                                          this._logger,
                                          `Device Index ${deviceMsg.DeviceIndex} does not exist`,
                                          id);
    }
    const device = this._devices.get(deviceMsg.DeviceIndex)!;
    if (device.AllowedMessageTypes.indexOf(aMessage.Type) < 0) {
      throw ButtplugException.LogAndError(ButtplugDeviceException,
                                          this._logger,
                                          `Device ${device.Name} does not take message type ${aMessage.Type.name}`,
                                          id);
    }
    this._logger.Trace(`DeviceManager: Sending ${deviceMsg.Type} to ${device.Name} (${deviceMsg.Id})`);
    return await device.ParseMessage(deviceMsg);
  }

  // Expects to get a connected, initialized device.
  private OnDeviceAdded = (device: IButtplugDevice) => {
    for (const dev of this._devices.values()) {
      if (dev.Id === device.Id) {
        this._logger.Info(`DeviceManager: Device ${device.Name} (id: ${device.Id}) already added, ignoring.`);
        return;
      }
    }
    const deviceIndex = this._deviceCounter;
    this._deviceCounter += 1;
    this._devices.set(deviceIndex, device);
    this._logger.Info(`DeviceManager: Device Added: ${device.Name} (${deviceIndex})`);
    device.addListener("deviceremoved", this.OnDeviceRemoved);
    this._msgClosure(new Messages.DeviceAdded(deviceIndex,
                                              device.Name,
                                              device.MessageSpecifications));
  }

  private OnDeviceRemoved = (deviceRemoved: IButtplugDevice) => {
    let deviceIndex: number | null = null;
    for (const [index, device] of Array.from(this._devices.entries())) {
      if (device === deviceRemoved) {
        deviceIndex = index;
        break;
      }
    }
    if (deviceIndex === null) {
      return;
    }
    deviceRemoved.removeAllListeners("deviceremoved");
    this._devices.delete(deviceIndex);
    this._logger.Info(`DeviceManager: Device Removed: ${deviceRemoved.Name} (${deviceIndex})`);
    this._msgClosure(new Messages.DeviceRemoved(deviceIndex));
  }

  private OnScanningFinished = () => {
    this._logger.Debug(`DeviceManager: Scanning Finished.`);
    for (const manager of this._subtypeManagers) {
      if (manager.IsScanning) {
        return;
      }
    }
    this._msgClosure(new Messages.ScanningFinished());
  }
}
