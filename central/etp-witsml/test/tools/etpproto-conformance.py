# Conformance check of the CRMF ETP v1.2 server with an INDEPENDENT ETP
# implementation: Geosiris etpproto (Apache-2.0) + etptypes models, over
# websockets. Nothing here shares code with the server.
#   pip install etpproto==1.0.7 etptypes fastavro websockets
#   python -I etpproto-conformance.py ws://host:8443 <portal JWT (viewer)>
import asyncio, sys, time
import websockets
from etpproto.messages import Message, MessageFlags
from etpproto.utils import get_all_etp_protocol_classes
from etptypes.energistics.etp.v12.datatypes.supported_protocol import SupportedProtocol
from etptypes.energistics.etp.v12.datatypes.version import Version
from etptypes.energistics.etp.v12.datatypes.object.context_info import ContextInfo
from etptypes.energistics.etp.v12.datatypes.object.context_scope_kind import ContextScopeKind
from etptypes.energistics.etp.v12.datatypes.object.relationship_kind import RelationshipKind
from etptypes.energistics.etp.v12.datatypes.object.index_interval import IndexInterval
from etptypes.energistics.etp.v12.datatypes.index_value import IndexValue
from etptypes.energistics.etp.v12.datatypes.channel_data.channel_range_info import ChannelRangeInfo
from etptypes.energistics.etp.v12.datatypes.channel_data.channel_subscribe_info import ChannelSubscribeInfo
from etptypes.energistics.etp.v12.protocol.core.request_session import RequestSession
from etptypes.energistics.etp.v12.protocol.core.close_session import CloseSession
from etptypes.energistics.etp.v12.protocol.discovery.get_resources import GetResources
from etptypes.energistics.etp.v12.protocol.store.get_data_objects import GetDataObjects
from etptypes.energistics.etp.v12.protocol.channel_subscribe.get_channel_metadata import GetChannelMetadata
from etptypes.energistics.etp.v12.protocol.channel_subscribe.get_ranges import GetRanges
from etptypes.energistics.etp.v12.protocol.channel_subscribe.subscribe_channels import SubscribeChannels
from etptypes.energistics.etp.v12.protocol.channel_data_frame.get_frame_metadata import GetFrameMetadata

CLASSES = get_all_etp_protocol_classes()
URL, TOKEN = sys.argv[1], sys.argv[2]
problems = []
def check(cond, what):
    print(('  ok   ' if cond else '  FAIL ') + what)
    if not cond: problems.append(what)

class Client:
    def __init__(self, ws):
        self.ws, self.next_id, self.last_server_id = ws, 2, 0
    async def send(self, obj):
        mid = self.next_id; self.next_id += 2
        msg = Message.get_object_message(obj, msg_id=mid, message_flags=MessageFlags.FINALPART)
        await self.ws.send(msg.encode_message())
        return mid
    async def receive(self):
        raw = await asyncio.wait_for(self.ws.recv(), 30)
        assert isinstance(raw, bytes), 'binary frames only'
        msg = Message.decode_binary_message(raw, CLASSES)
        mid = msg.header.message_id
        check(mid % 2 == 1 and mid > self.last_server_id, f'server message id {mid} odd and increasing ({type(msg.body).__name__})')
        self.last_server_id = mid
        return msg
    async def request(self, obj):
        mid = await self.send(obj)
        parts = []
        while True:
            msg = await self.receive()
            if msg.header.correlation_id != mid:
                continue          # unsolicited (e.g. streamed ChannelData)
            parts.append(msg)
            if msg.is_final_msg(): return parts

def v12(): return Version(major=1, minor=2, revision=0, patch=0)
def iv(us): return IndexValue(item=us)

async def main():
    async with websockets.connect(URL, subprotocols=['etp12.energistics.org'], max_size=64 * 1024 * 1024,
                                  additional_headers={'Authorization': f'Bearer {TOKEN}', 'etp-encoding': 'binary'}) as ws:
        c = Client(ws)
        print('Core')
        protos = [SupportedProtocol(protocol=p, protocol_version=v12(), role='store', protocol_capabilities={}) for p in (3, 4, 21, 2)]
        open_ = (await c.request(RequestSession(application_name='etpproto conformance', application_version='1.0.7',
            client_instance_id=b'\x11' * 16, requested_protocols=protos, supported_data_objects=[], supported_compression=[],
            supported_formats=['xml'], current_date_time=int(time.time() * 1e6), earliest_retained_change_time=0,
            server_authorization_required=False, endpoint_capabilities={})))[0].body
        check(type(open_).__name__ == 'OpenSession', 'RequestSession answered by OpenSession')
        check(sorted(p.protocol for p in open_.supported_protocols) == [2, 3, 4, 21], 'agreed protocols 2,3,4,21 (store)')

        print('Discovery')
        def ctx(uri, depth=1, types=()):
            return ContextInfo(uri=uri, depth=depth, data_object_types=list(types), navigable_edges=RelationshipKind.PRIMARY,
                               include_secondary_targets=False, include_secondary_sources=False)
        def gr(context, scope):
            return GetResources(context=context, scope=scope, count_objects=True, store_last_write_filter=None, active_status_filter=None, include_edges=False)
        wells = [r for m in await c.request(gr(ctx('eml:///', types=['witsml21.Well']), ContextScopeKind.SELF)) for r in m.body.resources]
        check(len(wells) >= 1, f'eml:/// lists {len(wells)} well(s)')
        well = next(w for w in wells if 'GS-11' in w.name)
        below = [r for m in await c.request(gr(ctx(well.uri, depth=2), ContextScopeKind.SOURCES)) for r in m.body.resources]
        kinds = {r.uri.split('/')[-1].split('(')[0] for r in below}
        check({'witsml21.Wellbore', 'witsml21.Log', 'witsml21.ChannelSet', 'witsml21.RigUtilization'} <= kinds, f'well sources at depth 2: {sorted(kinds)}')
        cs = next(r for r in below if 'ChannelSet' in r.uri)
        chans = [r for m in await c.request(gr(ctx(cs.uri, types=['witsml21.Channel']), ContextScopeKind.SOURCES)) for r in m.body.resources]
        check(len(chans) > 500, f'channel set has {len(chans)} channels')
        spp = next(r for r in chans if 'Pump Pressure' in r.name)

        print('Store')
        parts = await c.request(GetDataObjects(uris={'1': well.uri, '2': spp.uri}, format='xml'))
        objs = {k: v for m in parts for k, v in m.body.data_objects.items()}
        check(set(objs) == {'1', '2'}, 'GetDataObjects returned both objects')
        xml = objs['2'].data.decode('utf8')
        check('<witsml:Channel ' in xml and 'schemaVersion="2.1"' in xml and '<witsml:Uom>psi</witsml:Uom>' in xml, 'Channel is WITSML 2.1 in psi')

        print('ChannelSubscribe')
        meta = (await c.request(GetChannelMetadata(uris={'a': spp.uri})))[0].body.metadata['a']
        check(meta.uom == 'psi' and meta.channel_class_uri.startswith('eml:///eml23.PropertyKind('), f'metadata uom={meta.uom}, channelClassUri set')
        end = meta.indexes[0].interval.end_index.item
        rng = await c.request(GetRanges(request_uuid=b'\x22' * 16, channel_ranges=[ChannelRangeInfo(channel_ids=[meta.id_],
            interval=IndexInterval(start_index=iv(end - 10_000_000), end_index=iv(end), uom='us', depth_datum=''), secondary_intervals=[])]))
        pts = [d for m in rng for d in m.body.data]
        check(9 <= len(pts) <= 11, f'GetRanges: {len(pts)} points in 10 s')
        await c.send(SubscribeChannels(channels={'a': ChannelSubscribeInfo(channel_id=meta.id_, start_index=IndexValue(item=None), data_changes=True, request_latest_index_count=2)}))
        got, t0 = [], time.time()
        while len(got) < 4 and time.time() - t0 < 15:
            m = await c.receive()
            if type(m.body).__name__ == 'ChannelData': got += m.body.data
        check(len(got) >= 4, f'subscription delivered {len(got)} points')

        print('ChannelDataFrame')
        fm = (await c.request(GetFrameMetadata(uri=cs.uri, include_all_channel_secondary_indexes=False)))[0].body
        check(len(fm.channels) == len(chans), f'frame metadata lists {len(fm.channels)} channels')

        await c.send(CloseSession(reason='conformance check done'))
    print(f'\n{len(problems)} problem(s)' + (': ' + '; '.join(problems) if problems else ''))
    sys.exit(1 if problems else 0)

asyncio.run(main())
