import { PortNum } from './gen/meshtastic/portnums_pb.js';

import { MeshtasticPacketHandler } from './meshtastic_packet_handler.js';

function emojihash(hash) {
    const emojiSets = [
        ["🔴", "🟠", "🟡", "🟢", "🔵", "🟣"],
        ["🔴", "🟠", "🟡", "🟢", "🔵", "🟣"],
        ["🔴", "🟠", "🟡", "🟢", "🔵", "🟣"],
    ];

    return emojiSets.reduce(
        ([result, remaining], set) => [result + set[remaining % set.length], Math.floor(remaining / set.length)],
        ["", hash]
    )[0];
}

function addrFmt(address) {
    return `${emojihash(address)} !${address.toString(16).padStart(8, '0')}`.toUpperCase();
}

export class MeshtasticLogger {
    stream;
    handler;

    constructor(stream) {
        this.stream = stream;
        this.handler = new MeshtasticPacketHandler(this.stream);


        this.handler.on('textMessage', (message,  _, packet,) => { this.logPacket(packet, `Message: ${message}`); });
        this.handler.on('rangetest', (message,  _, packet,) => { this.logPacket(packet, `Rangetest: ${message}`); });
        this.handler.on('detectionSensor', (message,  _, packet,) => { this.logPacket(packet, `Detection Sensor: ${message}`); });

        this.handler.on('user',    (nodeInfo, _, packet,) => {
            this.logPacket(packet, `Short: ${nodeInfo.shortName.padStart(4)}   Long: ${nodeInfo.longName}${nodeInfo.isLicensed ? '   (🪪)' : ''}`);
        });

        this.handler.on('position', (position, _, packet,) => {
            this.logPacket(packet, `Lat: ${position.latitudeI} Lon: ${position.longitudeI} (https://www.google.com/maps/search/?api=1&query=${position.latitudeI/10000000},${position.longitudeI/10000000})`)
        });

        this.handler.on('traceroute', (pb, _, packet,) => {
            let path = [];
            for (let hop of pb.route.slice(0, -1)) {
                path.push(`${addrFmt(hop)} (${this.nodeName(hop)})`);
            }
            this.logPacket(packet, pb.constructor.typeName, path.join(' --> '));
        });

        for (let type of ['telemetry', 'storeAndForward', 'neighborinfo', 'routing', 'admin']) {
            this.handler.on(type, (pb, _, packet,) => {
                this.logPacket(packet, pb.constructor.typeName, pb.toJson());
            })
        }

        this.handler.on('encryptedPacket', (_, packet,) => {
            this.logPacket(packet);
        });

        this.handler.on('unhandled', (data, packet,) => {
            this.logPacket(packet, `Unhandled ${data.portnum} (${PortNum[data.portnum]})`);
        });
    }

    nodeName(addr) {
        if (addr == 0xFFFFFFFF) {
            return 'Everybody';
        }

        const info = this.stream.node_info[addr];

        if (info?.user?.longName) {
            return info.user.longName;
        }

        return '?';
    }
    
    logPacket(packet, msg=null, ...args) {
        const encrypted = packet.payloadVariant.case === "encrypted";
        const from = this.nodeName(packet.from);
        const to = this.nodeName(packet.to);


        console.debug(
            `[${new Date().toISOString()}]`,
            packet.viaMqtt ? '🌐 ' : '⚡️ ',
            encrypted ? '🤫 ' : '📢 ',
            `CH: ${packet.channel.toString().padStart(3)}`,
            `RSSI/SNR: ${packet.rxRssi.toString().padStart(4)}/${packet.rxSnr.toString().padStart(6)}`,
            `Hops: ${packet.hopLimit}/${packet.hopStart}`,
            ` === `,
            `${addrFmt(packet.from)} >=> ${addrFmt(packet.to)}`,
            `("${from}" >=> "${to}")`
        );

        if (typeof(msg) !== 'undefined' && msg && msg !== "") {
            console.debug(msg, ...args);
            console.debug();
        } else if (args.length > 0) {
            console.debug(...args);
            console.debug();
        }
    }    
}
