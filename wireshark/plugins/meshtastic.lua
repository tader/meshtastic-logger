do
    local protobuf_dissector = Dissector.get("protobuf")
    local protobuf_field_table = DissectorTable.get("protobuf_field")

    local function create_protobuf_dissector(name, desc, msgtype)
        local proto = Proto(name, desc)
        local f_length = ProtoField.uint32(name .. ".length", "Length", base.DEC)
        proto.fields = { f_length }

        proto.dissector = function(tvb, pinfo, tree)
            local subtree = tree:add(proto, tvb())
            if msgtype ~= nil then
                pinfo.private["pb_msg_type"] = "message," .. msgtype
            end
            pcall(Dissector.call, protobuf_dissector, tvb, pinfo, subtree)
            pinfo.columns.protocol:set(name)
        end

        return proto
    end

    local function add_payload_dissector(portnum, name, desc, msgtype)
        local proto = create_protobuf_dissector(name, desc, msgtype)

        -- proto.init = function()
        --     DissectorTable.get('packet.decoded.portnum'):add(portnum, proto)
        -- end

        return proto
    end


    local positionProto = add_payload_dissector(3, "position", "Meshtastic Position", "meshtastic.Position")
    local userProto = add_payload_dissector(4, "user", "Meshtastic User", "meshtastic.User")
    local telemetryDissector = add_payload_dissector(6, "telemetry", "Meshtastic Telemetry", "meshtastic.Telemetry")
    local routingDissector = add_payload_dissector(6, "routing", "Meshtastic Routing", "meshtastic.Routing")
    local adminMessageDissector = add_payload_dissector(6, "adminMessage", "Meshtastic Admin Message", "meshtastic.AdminMessage")
    local traceRouteDissector = add_payload_dissector(70, "routeDiscovery", "Meshtastic Traceroute", "meshtastic.RouteDiscovery")
    local fromRadioDissector = create_protobuf_dissector("fromRadio", "Meshtastic From Radio", "meshtastic.FromRadio")

    local payload_dissectors = {
        ["03"] = positionProto,
        ["04"] = userProto,
        ["05"] = routingDissector,
        ["06"] = adminMessageDissector,
        ["43"] = telemetryDissector,
        ["46"] = traceRouteDissector,
    }

    protobuf_names_f = Field.new("protobuf.field.name")
    protobuf_values_f = Field.new("protobuf.field.value")

    payload_proto = Proto("payload_payload", "Meshtastic Payload")
    payload_proto.dissector = function(tv, pinfo, tree)
        finfo_names = { protobuf_names_f() }
        finfo_values = { protobuf_values_f() }

        if (#finfo_names > 0) then
            for k, v in pairs(finfo_names) do
                -- process data and add results to the tree
                if string.format("%s", v) == "portnum" then
                    local proto = payload_dissectors[finfo_values[k].display]
                    if proto ~= nil then
                        pinfo.cols.protocol = proto.name
                        -- local subtree = tree:add(proto, tv)
                        pcall(Dissector.call, proto.dissector, tv, pinfo, tree)
                    end
                end
            end
        end
    end

    meshtastic_proto = Proto("meshtastic", "Meshtastic")
    meshtastic_proto.dissector = function(tv, pinfo, tree)
        fromRadioDissector.dissector:call(tv, pinfo, tree)

        finfo_names = { protobuf_names_f() }
        finfo_values = { protobuf_values_f() }

        if (#finfo_names > 0) then
            for k, v in pairs(finfo_names) do
                if string.format("%s", v) == "from" then
                    pinfo.columns.src:set(string.format("%s", finfo_values[k].value))
                elseif string.format("%s", v) == "to" then
                    pinfo.columns.dst:set(string.format("%s", finfo_values[k].value))
                end
            end
        end
    end

    protobuf_field_table:add("meshtastic.Data.payload", payload_proto)
end
