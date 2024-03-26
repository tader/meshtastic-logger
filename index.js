#!/usr/bin/env node

import crypto from 'crypto';
import { SerialPort } from 'serialport'
import { ToRadio, FromRadio, User, Position, NeighborInfo, Routing, RouteDiscovery } from './gen/meshtastic/mesh_pb.js';
import { PortNum } from './gen/meshtastic/portnums_pb.js';
import { Telemetry } from './gen/meshtastic/telemetry_pb.js';
import { StoreAndForward } from './gen/meshtastic/storeforward_pb.js';
import { AdminMessage } from './gen/meshtastic/admin_pb.js';

import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import PcapWriter from 'node-pcap-writer';

import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv)).argv;

if (typeof(argv['port']) === 'undefined') {
    console.error("Please pass the serial port with the Meshtatstic device, eg, `npm start -- --port /dev/cu.usbserial-0001`")
    process.exit(1);
}

async function sleep(duration=100) {
    await new Promise(r => setTimeout(r, duration));
}

class FileLogger {
    linkType = 162;  // https://www.gibbard.me/wireshark_lua_user_link_layer/

    fileInterval = 60 * 60 * 1000;
    file;
    fileName;

    pcFileInterval = 24 * 60 * 60 * 1000;
    pcWriter;
    pcFileName;

    constructor() {
        this.file = null;
        this.fileName = null;
        this.pcWriter = null;
        this.pcFileName = null
    }

    async getFile() {
        const fileDate = new Date(Math.floor(Date.now() / this.fileInterval)*this.fileInterval);
        const fileName = `log/meshtastic-log-${fileDate.toISOString()}.bin`;

        if (this.fileName != fileName) {
            if (this.file) {
                await this.file.close();
                this.file = null;
            }
            this.file = await fs.open(fileName, 'a');
            this.fileName = fileName;
        }

        return this.file;
    }

    async getPcapWriter() {
        const fileDate = new Date(Math.floor(Date.now() / this.pcFileInterval)*this.pcFileInterval);
        const fileName = `log/meshtastic-log-${fileDate.toISOString()}.pcap`;

        if (this.pcFileName != fileName) {
            if (this.pcWriter) {
                await this.pcWriter.close();
                this.pcWriter = null;
            }
            const pcFileName = `log/meshtastic-log-${new Date().toISOString()}.pcap`;
            this.pcWriter = new PcapWriter(pcFileName, 512, this.linkType);
            this.pcFileName = fileName;
        }

        return this.pcWriter;
    }

    async write(bytes) {
        const f = await this.getFile();
        await f.write(bytes);
    }

    async writePcap(bytes) {
        const f = await this.getPcapWriter();
        await f.writePacket(bytes);
    }
}

class Meshtastic extends EventEmitter {
    serialPort;
    rxbuf;
    configId;
    heartbeatTimer;
    logger;

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
        this.logger = new FileLogger();

        this.my_info = null;
        this.metadata = null;
        this.node_info = {};
        this.channel = {};
        this.config = {};
        this.moduleConfig = {};

        // meshtastic events
        this.on('fromRadio', async (fromRadio) => { this.handleFromRadioEvent(fromRadio); });
        this.on('packet', async (packet, fromRadio) => { this.handlePacketEvent(packet, fromRadio); });
        this.on('myInfo', async (data, fromRadio) => { this.handleMyInfoEvent(data, fromRadio); });
        this.on('metadata', async (data, fromRadio) => { this.handleMetadataEvent(data, fromRadio); });
        this.on('nodeInfo', async (data, fromRadio) => { this.handleNodeInfoEvent(data, fromRadio); });
        this.on('channel', async (data, fromRadio) => { this.handleChannelEvent(data, fromRadio); });
        this.on('config', async (data, fromRadio) => { this.handleConfigEvent(data, fromRadio); });
        this.on('moduleConfig', async (data, fromRadio) => { this.handleModuleConfigEvent(data, fromRadio); });
        this.on('configCompleteId', async (data, fromRadio) => { this.handleConfigCompleteIdEvent(data, fromRadio); });
        this.on('decodedPacket', async (data, packet, fromRadio) => { this.handleDecodedPacketEvent(data, packet, fromRadio); });

        // serial events
        this.serialPort.on('open', async () => {
            // console.debug('opened');
            await this.wakeRadio();
            await this.startConfig();
        });
        this.serialPort.on('close', () => this.dispatchEvent(new Event('disconnect')));
        this.serialPort.on('data', async (data) => {
            this.logger.write(data);
            // console.debug(`read ${data.length} bytes`)
            this.rxbuf = Buffer.concat([this.rxbuf, data]);
            while (await this.handleData());
        });
    }

    forward(pos) {
        // console.debug(`forwarding rxbuf by ${pos} bytes`);
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
                            await this.logger.writePcap(packetData);
                            const fromRadio = FromRadio.fromBinary(packetData);
                            // console.debug('<<', fromRadio);
                            this.forward(i+4+packetlen);
                            this.emit("fromRadio", fromRadio);
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
        // console.debug(this);
    }

    async handlePacketEvent(packet, fromRadio) {
        if (packet.rxRssi == 0 && packet.rxSnr == 0) {
            // these are not received on the radio
            return;
        }

        switch(packet.payloadVariant.case) {
            case "encrypted":
                this.emit('encryptedPacket', packet.payloadVariant.value, packet, fromRadio);
                break;

            case "decoded":
                this.emit('decodedPacket', packet.payloadVariant.value, packet, fromRadio);
                break;
        }
    }

    async handleDecodedPacketEvent(data, packet, fromRadio) {
        try {
            switch(data.portnum) {
                case PortNum.TEXT_MESSAGE_APP:
                    // https://github.com/meshtastic/firmware/blob/94e4301f2f5f224e0d1dc828aeca2846714d9e35/src/mesh/MeshService.h#L51
                    this.emit('textMessage', data.payload, data, packet, fromRadio);
                    break;

                case PortNum.POSITION_APP:
                    this.emit('position', Position.fromBinary(data.payload), data, packet, fromRadio);
                    break;

                case PortNum.NODEINFO_APP:
                    this.emit('user', User.fromBinary(data.payload), data, packet, fromRadio);
                    break;

                case PortNum.TELEMETRY_APP:
                    this.emit('telemetry', Telemetry.fromBinary(data.payload), data, packet, fromRadio);
                    // meshtastic.Telemetry {"time":1711121184,"deviceMetrics":{"batteryLevel":90,"voltage":4.052000045776367,"channelUtilization":14.110000610351562,"airUtilTx":3.1320831775665283}}
                    // meshtastic.Telemetry {"time":1711122354,"environmentMetrics":{"temperature":14.960000038146973,"relativeHumidity":53.4228515625,"barometricPressure":1015.53125}}
                    break;

                case PortNum.NEIGHBORINFO_APP:
                    this.emit('neighborinfo', NeighborInfo.fromBinary(data.payload), data, packet, fromRadio);
                    // !60579364 -> !FFFFFFFF meshtastic.NeighborInfo {"nodeId":1616352100,"lastSentById":1977719820,"nodeBroadcastIntervalSecs":300,"neighbors":[{"nodeId":3304581860,"snr":10}]}
                    break;

                case PortNum.STORE_FORWARD_APP:
                    this.emit('storeAndForward', StoreAndForward.fromBinary(data.payload), data, packet, fromRadio);
                    // meshtastic.StoreAndForward {"rr":"ROUTER_HEARTBEAT","heartbeat":{"period":900}}
                    break;
                
                case PortNum.ROUTING_APP:
                    this.emit('routing', Routing.fromBinary(data.payload), data, packet, fromRadio);
                    break;

                case PortNum.TRACEROUTE_APP:
                    this.emit('traceroute', RouteDiscovery.fromBinary(data.payload), data, packet, fromRadio);
                    break;
                
                case PortNum.RANGE_TEST_APP:
                    // https://github.com/meshtastic/firmware/blob/94e4301f2f5f224e0d1dc828aeca2846714d9e35/src/mesh/MeshService.h#L51
                    this.emit('rangetest', data.payload, data, packet, fromRadio);
                    break;
                
                case PortNum.DETECTION_SENSOR_APP:
                    // https://github.com/meshtastic/firmware/blob/94e4301f2f5f224e0d1dc828aeca2846714d9e35/src/mesh/MeshService.h#L51
                    this.emit('detectionSensor', data.payload, data, packet, fromRadio);
                    break;
                
                case PortNum.ADMIN_APP:
                    this.emit('admin', AdminMessage.fromBinary(data.payload), data, packet, fromRadio);
                    break;
    
                default:
                    this.emit('unhandled', data, packet, fromRadio);
                    break;
            }
        } catch(e) {
            console.error(e);
        }
    }

    addrFmt(address) {
        const addr = `!${address.toString(16).padStart(8, '0')}`.toUpperCase();
        const info = this.node_info[address];

        return `${addr}${info ? ' ('+ info.user.longName +')' : ''}`;
    }
    
    logPacket(packet, msg=null, ...args) {
        const encrypted = packet.payloadVariant.case === "encrypted";
        console.debug(`[${new Date().toISOString()}] (CH: ${packet.channel.toString().padStart(3)}) ==> ${this.addrFmt(packet.from)} -> ${this.addrFmt(packet.to)} ${encrypted ? '🤫' : '📢'}  @ ${packet.rxRssi.toString().padStart(4)}/${packet.rxSnr.toString().padStart(6)} Hops: ${packet.hopLimit}/${packet.hopStart}${packet.viaMqtt ? ' 🌐' : ' ⚡️'}${msg ? '  ' + msg : ''}`, ...args);
    }    
}


(async () => {

    const port = new SerialPort({
        path: argv.port,
        baudRate: 115200,
    });
    const meshtastic = new Meshtastic(port);

    // meshtastic.on('toRadio', (fromRadio) => {
    //     console.log('<<', fromRadio);
    // });

    // meshtastic.on('fromRadio', (fromRadio) => {
    //     console.log('>>', fromRadio);
    // });

    meshtastic.on('textMessage', (message,  _, packet) => { meshtastic.logPacket(packet, `Message: ${message}`); });
    meshtastic.on('rangetest', (message,  _, packet) => { meshtastic.logPacket(packet, `Rangetest: ${message}`); });
    meshtastic.on('detectionSensor', (message,  _, packet) => { meshtastic.logPacket(packet, `Detection Sensor: ${message}`); });

    meshtastic.on('user',    (nodeInfo, _, packet) => {
        meshtastic.logPacket(packet, `Short: ${nodeInfo.shortName.padStart(4)}   Long: ${nodeInfo.longName}${nodeInfo.isLicensed ? '   (🪪)' : ''}`);
    })

    meshtastic.on('position', (position, data, packet, fromRadio) => {
        meshtastic.logPacket(packet, `Lat: ${position.latitudeI} Lon: ${position.longitudeI} (https://www.google.com/maps/search/?api=1&query=${position.latitudeI/10000000},${position.longitudeI/10000000})`)
    });

    meshtastic.on('traceroute', (pb, _, packet,) => {
        let path = [];
        for (let hop of pb.route) {
            path.push(meshtastic.addrFmt(hop));
        }
        meshtastic.logPacket(packet, `${pb.constructor.typeName} ${pb.toJsonString({prettySpaces:false})} (${path.join(' --> ')})`);
    })

    for (let type of ['telemetry', 'storeAndForward', 'neighborinfo', 'routing', 'admin']) {
        meshtastic.on(type, (pb, _, packet,) => {
            meshtastic.logPacket(packet, `${pb.constructor.typeName} ${pb.toJsonString({prettySpaces:false})}`);
        })
    }

    meshtastic.on('encryptedPacket', (_, packet,) => {
        meshtastic.logPacket(packet);
    })

    meshtastic.on('unhandled', (data, packet,) => {
        meshtastic.logPacket(packet, `Unhandled ${data.portnum} (${PortNum[data.portnum]})`);
    })

})()
    .then((x) => {})
    .catch((x) => console.error(x))
    ;
