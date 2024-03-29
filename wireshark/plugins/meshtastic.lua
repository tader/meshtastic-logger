do
    nodeinfo_table = {
        ['!FFFFFFFF'] = "Broadcast"
    }

    -- a debug logging function (adds into dissector proto tree)
    local enable_logging = false   -- set this to true to enable it!!
    local function initLog(tree, proto)
        if not enable_logging then
            -- if logging is disabled, we return a dummy function
            return function() return end
        end
        local log_tree = tree:add(proto, nil, "Debug Log")
        log_tree:set_generated()
        -- return a function that when called will add a new child with the given text
        return function(str) log_tree:add(proto):set_text(str) end
    end



    local protobuf_dissector = Dissector.get("protobuf")
    local protobuf_field_table = DissectorTable.get("protobuf_field")

    local function create_protobuf_dissector(name, msgtype)
        local proto = Proto(name, msgtype)
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

    local textMessageDissector = Proto('textmessage', 'Textmessage')
    local message_text_field = ProtoField.new("Message", "message.text", ftypes.STRING)
    textMessageDissector.fields = { message_text_field }
    textMessageDissector.dissector = function(tvb, pinfo, tree)
        local subtree = tree:add(textMessageDissector, tvb())
        subtree:add(message_text_field, tvb():string(ENC_UTF_8))
        pinfo.columns.protocol:set('textmessage')
    end

    payload_dissectors = {
        ["01"] = textMessageDissector,
        ["0A"] = textMessageDissector,
        ["20"] = textMessageDissector,
        ["42"] = textMessageDissector,
    }

    local function add_payload_dissector(portnum, name, msgtype)
        local proto = create_protobuf_dissector(name, msgtype)

        payload_dissectors[string.format("%02X", portnum)] = proto
        return proto
    end



    -- (1) -- text messages use the textMessageDissector
    add_payload_dissector(2, "position", "meshtastic.Position")
    add_payload_dissector(3, "hardwareMessage", "meshtastic.HardwareMessage")
    add_payload_dissector(4, "user", "meshtastic.User")
    add_payload_dissector(5, "routing", "meshtastic.Routing")
    add_payload_dissector(6, "adminMessage", "meshtastic.AdminMessage")
    -- (7) -- compressed text messages are decompressed by the node
    add_payload_dissector(8, "waypoint", "meshtastic.Waypoint")
    -- (9) -- codec2 audio frames with header (https://github.com/meshtastic/protobufs/blob/dea3a82ef2accd25112b4ef1c6f8991b579740f4/meshtastic/portnums.proto#L94)
    -- (10) -- detection sensor uses the textMessageDissector
    -- (32) -- ping replies use the textMessageDissector
    -- (33) -- ip packet bytes (maby native Wireshark decoding?)
    add_payload_dissector(34, "paxCounter", "meshtastic.Paxcount")
    -- (64) -- bytes to send to serial port
    add_payload_dissector(65, "storeForward", "meshtastic.StoreAndForward")
    -- (66) -- range test uses the textMessageDissector
    add_payload_dissector(67, "telemetry", "meshtastic.Telemetry")
    -- (68) -- zps arrays of int64 for estimation of position without GPS
    -- (69) -- used for simulating meshtastic
    add_payload_dissector(70, "routeDiscovery", "meshtastic.RouteDiscovery")
    add_payload_dissector(71, "neighborInfo", "meshtastic.NeighborInfo")
    -- (72) -- ATAK Plugin
    -- Other: (73) map report app, (256) private app, (257) atak forwarder, (511) max portnum
    
    local fromRadioDissector = create_protobuf_dissector("fromRadio", "meshtastic.FromRadio")

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
                    local proto = payload_dissectors[string.format("%02X", finfo_values[k].range:uint())]
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
        local log = initLog(tree,meshtastic_proto)
        local values = {}

        fromRadioDissector.dissector:call(tv, pinfo, tree)

        local finfo_names = { protobuf_names_f() }
        local finfo_values = { protobuf_values_f() }

        if (#finfo_names > 0) then
            for k, v in pairs(finfo_names) do
                values[tostring(v)] = finfo_values[k]
                log(tostring(v) .. ": " .. values[tostring(v)].display)
            end
        end

        local from_addr = nil
        if (values['from']) then
            from_addr = string.format("!%08X", values['from'].range:le_uint())
            pinfo.columns.src:set(from_addr)
        end

        local user_id = nil
        if (values['macaddr'] and values['id']) then
            user_id = string.upper(values['id'].range:string())
        end

        local to_addr = nil
        if (values['to']) then
            to_addr = string.format("!%08X", values['to'].range:le_uint())
            pinfo.columns.dst:set(to_addr)
        end

        if (values['long_name']) then
            local key = nil
            local long_name = values['long_name'].range:string(ENC_UTF_8)

            if (from_addr) then
                key = from_addr
            elseif (user_id) then
                key = user_id
            end

            if (key) then
                nodeinfo_table[key] = long_name
                log("Stored: nodeinfo_table['" .. tostring(key) .. "'] = '" .. tostring(nodeinfo_table[key]) .. "'")
            end
        end
    end

    protobuf_field_table:add("meshtastic.Data.payload", payload_proto)




    local nodeinfo_p = Proto("mt_nodeinfo", "Packet Info")
    local nodeinfo_from_field = ProtoField.string("src_long_name", "Sender")
    local nodeinfo_to_field = ProtoField.string("dst_long_name", "Receiver")
    nodeinfo_p.fields = { nodeinfo_from_field, nodeinfo_to_field }
    register_postdissector( nodeinfo_p )
    nodeinfo_p.dissector = function(tvb, pinfo, tree)
        local subtree = tree:add(nodeinfo_p, tvb())
        local values = {}
        
        local finfo_names = { protobuf_names_f() }
        local finfo_values = { protobuf_values_f() }

        if (#finfo_names > 0) then
            for k, v in pairs(finfo_names) do
                values[tostring(v)] = finfo_values[k]
            end
        end

        local from_addr = nil
        if (values['from']) then
            from_addr = string.format("!%08X", values['from'].range:le_uint())
            pinfo.columns.src:set(from_addr)
        end

        local to_addr = nil
        if (values['to']) then
            to_addr = string.format("!%08X", values['to'].range:le_uint())
            pinfo.columns.dst:set(to_addr)
        end

        if (from_addr and nodeinfo_table[from_addr]) then
            subtree:add(nodeinfo_from_field, nodeinfo_table[from_addr])
        end

        if (to_addr and nodeinfo_table[to_addr]) then
            subtree:add(nodeinfo_to_field, nodeinfo_table[to_addr])
        end
    end
end
