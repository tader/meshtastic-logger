import { EventEmitter } from 'node:events';

import crypto from 'crypto';

import { ToRadio, FromRadio } from './gen/meshtastic/mesh_pb.js';


async function sleep(duration=100) {
    await new Promise(r => setTimeout(r, duration));
}


export class MeshtasticSerial extends EventEmitter {
    serialPort;
    rxbuf;
    configId;
    heartbeatTimer;

    my_info;
    metadata;
    node_info;
    channel;
    config;
    moduleConfig;

    constructor(serialPort) {
        super();
        this.serialPort = serialPort;
        this.rxbuf = Buffer.alloc(0);
        this.configId = crypto.randomInt(0xFFFFFFFF);

        this.my_info = null;
        this.metadata = null;
        this.node_info = {};
        this.channel = {};
        this.config = {};
        this.moduleConfig = {};

        // meshtastic events
        this.on('fromRadio', async (fromRadio) => { this.handleFromRadioEvent(fromRadio); });
        this.on('myInfo', async (data, fromRadio) => { this.handleMyInfoEvent(data, fromRadio); });
        this.on('metadata', async (data, fromRadio) => { this.handleMetadataEvent(data, fromRadio); });
        this.on('nodeInfo', async (data, fromRadio) => { this.handleNodeInfoEvent(data, fromRadio); });
        this.on('channel', async (data, fromRadio) => { this.handleChannelEvent(data, fromRadio); });
        this.on('config', async (data, fromRadio) => { this.handleConfigEvent(data, fromRadio); });
        this.on('moduleConfig', async (data, fromRadio) => { this.handleModuleConfigEvent(data, fromRadio); });
        this.on('configCompleteId', async (data, fromRadio) => { this.handleConfigCompleteIdEvent(data, fromRadio); });

        // serial events
        this.serialPort.on('open', async () => {
            await this.wakeRadio();
            await this.startConfig();
        });

        this.serialPort.on('close', () => { this.emit('disconnect'); });

        this.serialPort.on('data', async (data) => {
            this.rxbuf = Buffer.concat([this.rxbuf, data]);
            while (await this.handleData());
        });
    }

    forward(pos) {
        this.rxbuf = this.rxbuf.slice(pos);
    }

    async handleData() {
        const head = [0x94, 0xC3];
        const l = this.rxbuf.length;

        if (l == 0) return false;

        let i;

        for (i = 0; i < l; i++) {
            if (this.rxbuf[i] == head[0]) {
                if (i+1 >= l) {
                    // we forward all the way to the last byte,
                    // which might be the start of the header,
                    // we need more data to continue
                    this.forward(i);
                    return false;
                } else if (this.rxbuf[i+1] == head[1]) {
                    // we found the two bytes that indicate the start of a packet

                    if (i+3 >= l) {
                        // we have too little data to judge if it is a real packet
                        // we need more data to continue
                        this.forward(i);
                        return false;
                    }

                    const packetlen = (this.rxbuf[i+2] << 8) + this.rxbuf[i+3];

                    if (packetlen > 512) {
                        // we found something that looked like the header of a packet,
                        // but the indicated length is too big, continue searching...
                        continue;
                    }

                    if (i+3+packetlen >= l) {
                        // we found something that looked like the header of a packet,
                        // but we don't have received enough bytes for the full packet
                        // we need more data to continue
                        this.forward(i);
                        return false;
                    } else {
                        // we found something that really looks like a full packet, 
                        // attempting to parse the packet!

                        const packetData = this.rxbuf.slice(i+4, i+4+packetlen);
                        try {
                            const fromRadio = FromRadio.fromBinary(packetData);
                            this.forward(i+4+packetlen);
                            this.emit("fromRadio", fromRadio, packetData);
                            return true;
                        } catch(e) {
                            console.error("X", e);
                            // it did not parse, continue searching
                            continue;
                        }
                    }
                }

            }
        }

        if (i == l) {
            // did not find anything that looks like 
            // console.debug('did not find 0x94 in buffer');
            console.log(new TextDecoder().decode(this.rxbuf));
            this.forward(i);
        }
    }

    async sendToRadio(data) {
        if (typeof(this.heartbeatTimer) !== 'undefined') {
            clearTimeout(this.heartbeatTimer);
        }

        const bytes = data.toBinary();
        const bufLen = bytes.length;
        const header = Uint8Array.from([0x94, 0xC3, (bufLen >> 8) & 0xFF, bufLen & 0xFF]);
        const packet = Buffer.concat([header, bytes]);
        this.serialPort.write(packet);

        this.heartbeatTimer = setTimeout(async () => { this.sendHeartBeat(); }, 10000);

        this.emit('toRadio', data);
    }

    async startConfig() {
        const toRadio = new ToRadio();
        toRadio.payloadVariant.case = 'wantConfigId'
        toRadio.payloadVariant.value = this.configId;
        this.sendToRadio(toRadio);
    }

    async sendHeartBeat() {
        this.sendToRadio(new ToRadio());
    }

    async wakeRadio() {
        const data = new Uint8Array(32);
        for (let i=0; i<data.length; i++) {
            data[i] = 0xC3;
        }
        this.serialPort.write(data);
        await sleep();
    }

    async handleFromRadioEvent(fromRadio) {
        this.emit(
            fromRadio.payloadVariant.case,
            fromRadio.payloadVariant.value,
            fromRadio
        );
    }

    async handleMyInfoEvent(data, _) {
        this.my_info = data;
    }

    async handleMetadataEvent(data, _) {
        this.metadata = data;
    }

    async handleNodeInfoEvent(data, _) {
        this.node_info[data.num] = data;
    }

    async handleChannelEvent(data, _) {
        this.channel[data.index] = data;
    }

    async handleConfigEvent(data, _) {
        for (const key of ['device', 'position', 'power', 'network', 'display', 'lora', 'bluetooth']) {
            if (data[key]) {
                this.config[key] = data[key];
            }
        }
    }

    async handleModuleConfigEvent(data, _) {
        this.moduleConfig[data.payloadVariant.case] = data.payloadVariant.value;
    }

    async handleConfigCompleteIdEvent(data, _) {
    }
 }
