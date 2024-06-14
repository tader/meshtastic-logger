import { EventEmitter } from 'node:events';

import { PortNum } from './gen/meshtastic/portnums_pb.js';
import { User, Position, NeighborInfo, Routing, RouteDiscovery } from './gen/meshtastic/mesh_pb.js';
import { Telemetry } from './gen/meshtastic/telemetry_pb.js';
import { StoreAndForward } from './gen/meshtastic/storeforward_pb.js';
import { AdminMessage } from './gen/meshtastic/admin_pb.js';


export class MeshtasticPacketHandler extends EventEmitter {
    stream;

    constructor(stream, ignoreNonRf = true) {
        super();
        this.stream = stream;
        this.ignoreNonRf = ignoreNonRf;

        this.stream.on('packet', async (packet, fromRadio) => { this.handlePacketEvent(packet, fromRadio); });
        this.on('decodedPacket', async (data, packet, fromRadio) => { this.handleDecodedPacketEvent(data, packet, fromRadio); });
    }

    async handlePacketEvent(packet, fromRadio) {
        if (this.ignoreNonRf && packet.rxRssi == 0 && packet.rxSnr == 0) {
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
                    this.emit('textMessage', data.payload.toString('utf-8'), data, packet, fromRadio);
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
                    this.emit('rangetest', data.payload.toString('utf-8'), data, packet, fromRadio);
                    break;
                
                case PortNum.DETECTION_SENSOR_APP:
                    // https://github.com/meshtastic/firmware/blob/94e4301f2f5f224e0d1dc828aeca2846714d9e35/src/mesh/MeshService.h#L51
                    this.emit('detectionSensor', data.payload.toString('utf-8'), data, packet, fromRadio);
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
}
