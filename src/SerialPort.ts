'use strict';

const SP = require("../blp-serial");

import { Disposable } from 'vscode';
import { dump } from './utils';

interface ISerialPortOptions { baudRate: number, autoOpen?: boolean, parity?: string, hupcl?: boolean }
export interface ISerialPortInfo {
    name: string,
    serialNumber: string,
    deviceName: string,
    sysCode: number
}

const DEBUG = false;

export class SerialPort implements Disposable {
    private _dataTimeout: number = 0;
    private _dataTimeoutId: NodeJS.Timer | null = null;
    private _readCallTimerId: NodeJS.Timer | null = null;
    private _currentErrorCallback: any;
    private _inDataQueue: Uint8Array[];
    private _onResult: ((data: Uint8Array) => void) | null = null;
    private _port: any;
    private _portName: string;

    constructor(port: string, options?: ISerialPortOptions) {
        options = options || {
            baudRate: 9600,
        };
        this._portName = port;
        options.autoOpen = false;
        options.hupcl = false;
        this._port = new SP(this._portName, options);

        this._inDataQueue = [];

        this._port.on('data', (data: Buffer) => {
            DEBUG && console.log('[SERIAL] received ' + data.byteLength + ' bytes');
            DEBUG && console.log('[SERIAL] <\n' + dump(data));
            if (this._inDataQueue.length && !this._dataTimeout) {
                DEBUG && console.log('[SERIAL] CB - queue not empty, add new data to it');
                this._inDataQueue.push(new Uint8Array(data));
            } else if (this._onResult) {
                if (this._dataTimeout) {
                    DEBUG && console.log('[SERIAL] CB - has a data timeout. pushing data to queue');
                    this._inDataQueue.push(new Uint8Array(data));
                    if (this._dataTimeoutId) {
                        clearTimeout(this._dataTimeoutId);
                    }
                    this._dataTimeoutId = setTimeout(() => {
                        DEBUG && console.log('[SERIAL] data wait time out reached. resolving');
                        this._dataTimeoutId = null;
                        let mergedData = this._inDataQueue.reduce((l, r) => {
                            var res = new Uint8Array(l.length + r.length);
                            res.set(l, 0);
                            res.set(r, l.length);
                            return res;
                        });
                        this._inDataQueue = [];
                        if (this._onResult) {
                            this._onResult(mergedData);
                        }
                    }, this._dataTimeout);
                } else {
                    DEBUG && console.log('[SERIAL] CB - calling callback function directly');
                    this._onResult(new Uint8Array(data));
                }
            } else {
                DEBUG && console.log('[SERIAL] CB - got data without read requested. pushing to queue');
                this._inDataQueue.push(new Uint8Array(data));
            }
        });

        this._port.on('error', (error: Error) => {
            DEBUG && console.log('[SERIAL] error: ' + error.message);
            if (this._currentErrorCallback) {
                this._currentErrorCallback(error);
            }
        });
    }

    open(): Promise<void> {
        return new Promise((resolve, reject) => {
            DEBUG && console.log('[SERIAL] open ' + this._portName);

            this._port.open((error: any) => {
                if (error) {
                    DEBUG && console.log('[SERIAL] error opening:', error.message);
                    reject(error);
                } else {
                    DEBUG && console.log('[SERIAL] port opened');
                    resolve();
                }
            });
        });
    }

    openForUpload(brk?: boolean, dtr?: boolean): Promise<void> {
        return new Promise((resolve, reject) => {
            DEBUG && console.log('[SERIAL] openForUpload with BRK:', brk, ', DTR:', dtr);
            this.open()
                .then(() => {
                    if (brk) {
                        return this.toggleBRK();
                    }
                    return Promise.resolve();
                })
                .then(() => {
                    if (dtr) {
                        return this.toggleDTR();
                    }
                    return Promise.resolve();
                })
                .then(() => {
                    DEBUG && console.log('[SERIAL] openForUpload resolving');
                    resolve();
                })
                .catch(reject)
        });
    }

    toggleBRK(): Promise<void> {
        return new Promise((resolve, reject) => {
            DEBUG && console.log('[SERIAL] toggle BRK');
            this.setOptions({ brk: true, dtr: false })
                .then(() => {
                    return this.setOptions({ brk: false, dtr: false });
                })
                .then(resolve)
                .catch(reject)
        });
    }

    toggleDTR(): Promise<void> {
        return new Promise((resolve, reject) => {
            DEBUG && console.log('[SERIAL] toggle DTR');
            this.setOptions({ dtr: true })
                .then(() => {
                    return this.setOptions({ dtr: false });
                })
                .then(resolve)
                .catch(reject)
        });
    }

    close(): Promise<void> {
        return new Promise((resolve, reject) => {
            DEBUG && console.log('[SERIAL] close');
            this._inDataQueue = [];
            this._onResult = null;
            this._readCallTimerId = null;
            this._dataTimeoutId = null;
            this._dataTimeout = 0;
            this._currentErrorCallback = null;

            this._port.close((error: Error) => {
                if (error) {
                    DEBUG && console.log('[SERIAL] error closing: ' + error.message);
                    reject(error);
                } else {
                    DEBUG && console.log('[SERIAL] port closed');
                    resolve();
                }
            });
        });
    }

    setReadListener(onData: (data: Uint8Array) => void) {
        this._onResult = onData;
    }

    read(dataTimeout?: number): Promise<Uint8Array> {
        return new Promise((resolve, reject) => {
            DEBUG && console.log('[SERIAL] read');
            if (!this.isOpen()) {
                DEBUG && console.log('[SERIAL] read - not opened');
                reject(new Error('Serial Port is closed'));
            } else if (this._readCallTimerId) {
                DEBUG && console.log('[SERIAL] read in progress');
                reject(new Error('Previous read operation still waiting for data'));
            } else {
                this._dataTimeout = dataTimeout || 0;
                if (this._inDataQueue.length && !dataTimeout) {
                    let data = this._inDataQueue.shift();
                    DEBUG && console.log('[SERIAL] read got data from queue');
                    resolve(data);
                    return;
                } else {
                    this._onResult = (data: Uint8Array) => {
                        DEBUG && console.log('[SERIAL] read called from read CB');
                        if (this._readCallTimerId) {
                            clearTimeout(this._readCallTimerId);
                            this._readCallTimerId = null;
                        }
                        this._onResult = null;
                        resolve(data);
                    }

                    this._readCallTimerId = setTimeout(() => {
                        DEBUG && console.log('[SERIAL] read timed out. rejecting.');
                        this._readCallTimerId = null;
                        this._onResult = null;
                        this._inDataQueue = [];
                        reject(new Error('Device is not reponding. Check if you\'ve selected the right target device and correct serial port.'));
                    }, 2000 + this._dataTimeout);
                }
            }
        });
    }

    write(data: Uint8Array): Promise<void> {
        return new Promise((resolve, reject) => {
            DEBUG && console.log('[SERIAL] write');
            DEBUG && console.log('[SERIAL] >\n' + dump(data));
            this._port.write(Buffer.from(data.buffer), null, (error: Error) => {
                if (error) {
                    DEBUG && console.log('[SERIAL] error writing: ' + error.message);
                    reject(error.message);
                } else {
                    DEBUG && console.log('[SERIAL] sent ' + data.byteLength + ' bytes');
                    resolve();
                }
            });
        });
    }

    setOptions(options: any): Promise<void> {
        return new Promise((resolve, reject) => {
            DEBUG && console.log('[SERIAL] set options');
            this._port.set(options, (error: any) => {
                if (error) {
                    DEBUG && console.log('[SERIAL] set options error: ' + error.message);
                    reject(error.message);
                } else {
                    DEBUG && console.log('[SERIAL] options set');
                    setTimeout(() => {
                        resolve();
                    }, 20)
                }
            });
        });
    }

    isOpen(): boolean {
        return this._port && this._port.isOpen;
    }

    dispose() {
        if (this.isOpen()) {
            this._port.close();
        }
        this._port = null;
    }

    static list(): Promise<ISerialPortInfo[]> {
        return new Promise((resolve, reject) => {
            SP.list()
                .then((foundPorts: Array<any>) => {
                    let ports: ISerialPortInfo[] = foundPorts.map((port: any) => {
                        return {
                            serialNumber: port.serialNumber,
                            name: port.comName,
                            deviceName: port.deviceName,
                            sysCode: port.bcdDevice
                        }
                    });
                    resolve(ports);
                })
                .catch(reject);
        });
    }
}