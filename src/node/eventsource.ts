import { EventSource } from "eventsource";
import { configureEventSource } from "@arkade-os/sdk";

// Node has no global EventSource; the SDK's batch and contract streams are server-sent events.
configureEventSource((url) => new EventSource(url) as never);
