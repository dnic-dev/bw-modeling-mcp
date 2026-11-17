import { BwClient } from '../bw-client.js';

export interface CreateTransportTaskArgs {
  transportRequest: string;
  user: string;
}

const TM_MEDIA_TYPE = 'application/vnd.sap.adt.transportorganizer.v1+xml';

/**
 * bw_create_transport_task — add a task (sub-request) for a user to a transport request.
 * Endpoint, body and response shape: see payloads/create_transport_task.md.
 */
export async function bwCreateTransportTask(
  client: BwClient,
  args: CreateTransportTaskArgs
): Promise<string> {
  const trUpper = args.transportRequest.toUpperCase();
  const userUpper = args.user.toUpperCase();

  const path = `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(trUpper)}/tasks`;

  const body = `<?xml version="1.0" encoding="ASCII"?>
<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:number="${trUpper}" tm:targetuser="${userUpper}" tm:useraction="newtask"/>`;

  // Content-Type is text/plain even though the body is XML; Accept differs from Content-Type.
  const response = await client.postRaw(path, body, 'text/plain', { Accept: TM_MEDIA_TYPE });

  const taskMatch = response.match(/tm:number="([^"]+)"/);
  const taskNumber = taskMatch ? taskMatch[1] : '';

  return JSON.stringify({
    success: taskNumber !== '',
    transport_request: trUpper,
    user: userUpper,
    task: taskNumber || null,
  }, null, 2);
}
