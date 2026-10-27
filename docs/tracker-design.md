# Personal Outreach Tracker — V1 Requirements

## Scope
- Local, single-user bookkeeping in a separate Tracker tab from Discovery.
- Manual entry; records persist across application restarts.
- Sending messages and automated notifications are outside V1.

## Core functionality
- **Companies:** Add and edit a company name and optional summary/notes.
- **Contacts:** Add and edit multiple contacts per company, with name, optional email, and links.
- **Outreach history:** Record, edit, and delete message records, including message text, sent date/time, and optional notes. Corrections affect bookkeeping only.
- **Sequences:** Allow repeat outreach to a contact while preserving previous sequences. Keep at most one open sequence per contact; starting new outreach records an initial message and closes any existing open sequence.
- **Responses:** Manually record a response on its sequence, closing it and stopping pending follow-ups.
- **Follow-ups:** In an open sequence, each follow-up is due 3 days after the previous message was actually sent. Record each follow-up when sent; close the sequence after two follow-ups. Allow manual closure at any time.
- **Tracker list:** Show company, contact, outreach progress, and next follow-up date. Sort by next follow-up due date, overdue first, or most recent outreach; keep uncontacted contacts accessible.

## Follow-up timing
Only one follow-up is pending at a time: the first is due 3 days after initial outreach, and the second 3 days after the first follow-up is sent. On schedule, these fall on days 3 and 6. Late sending shifts the next due date. Missed dates remain overdue; they do not trigger automatic sending. Closed sequences generate no follow-ups.

Enter the initial sent timestamp manually. Follow-up sent timestamps default to now and can be edited for backdating. Editing a sent timestamp recalculates any pending follow-up date. For V1, 3 days means 72 elapsed hours; display timestamps in local time.

## Data and persistence
- Store tracker data in a local JSON file managed by the server: companies contain contacts; contacts contain sequences; sequences contain sent messages.
- Give each company, contact, sequence, and message a stable ID. Store company/contact details and message kind (initial, first follow-up, second follow-up), text, sent timestamp, and optional notes.
- Each sequence stores `closedAt` (null while open), `closeReason` (null, `responded`, `completed`, `manual`, or `restarted`), and optional `respondedAt`. A response, second follow-up, manual stop, or restart closes the sequence. The reason distinguishes automatic completion from other closures when correcting messages.
- Derive outreach progress, next follow-up date, and overdue status from stored facts and the current time; do not persist these calculated values.
- Recalculate after loading or editing data, on tab focus, and periodically while the tracker is open.
- Save edits safely on the server before confirming success or updating the UI with the saved result.

## Example stored JSON
Illustrative field names and IDs; timestamps include a timezone. Derived status and follow-up dates are not stored.

```json
{
  "companies": [
    {
      "id": "company_1",
      "name": "Example Labs",
      "notes": "Interested in their engineering team.",
      "contacts": [
        {
          "id": "contact_1",
          "name": "Alex Chen",
          "email": "alex@example.com",
          "links": ["https://example.com/team/alex"],
          "sequences": [
            {
              "id": "sequence_1",
              "closedAt": null,
              "closeReason": null,
              "respondedAt": null,
              "messages": [
                {
                  "id": "message_1",
                  "kind": "initial",
                  "text": "Hi Alex, I'd like to learn about your engineering team.",
                  "sentAt": "2026-10-20T10:00:00-05:00",
                  "notes": "Sent by email."
                },
                {
                  "id": "message_2",
                  "kind": "follow_up_1",
                  "text": "Hi Alex, following up on my earlier message.",
                  "sentAt": "2026-10-23T10:00:00-05:00",
                  "notes": ""
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

Here, the second follow-up is due October 26, 2026 at 10:00 AM (UTC−05:00), three days after the first follow-up. Recording it closes the sequence. A response closes it earlier; another outreach attempt creates a new sequence without replacing this history.

## API design

The server owns IDs, validation, sequence transitions, derived state, and JSON persistence. Routes use stable record IDs.

| Method | Route | Input / behavior |
| --- | --- | --- |
| GET | `/api/tracker` | Return companies with nested history and derived contact status, `nextFollowUpAt`, and `isOverdue`; include top-level `computedAt`. |
| POST | `/api/tracker/companies` | Create with `name` and optional `notes`. |
| PATCH | `/api/tracker/companies/:id` | Update `name` and/or `notes`. |
| POST | `/api/tracker/companies/:id/contacts` | Create with `name`, optional `email`, and `links`. |
| PATCH | `/api/tracker/contacts/:id` | Update contact details. |
| POST | `/api/tracker/contacts/:id/sequences` | Create with initial message `{text, sentAt, notes?}`; close any open sequence as `restarted` in the same save. |
| POST | `/api/tracker/sequences/:id/follow-ups` | Record `{text, sentAt, notes?}`; server assigns the next follow-up kind and closes after the second. |
| PATCH | `/api/tracker/sequences/:id` | Accept `{action: "record_response" \| "close", at}`; server sets response/closure fields. |
| PATCH | `/api/tracker/messages/:id` | Update `text`, `sentAt`, and/or `notes`; message kind stays fixed. |
| DELETE | `/api/tracker/messages/:id` | Delete a mistaken message, subject to the correction rules below. |

### Validation and corrections
- Require nonempty names/message text and valid timestamps with timezone offsets. Sent timestamps must follow message order and cannot be in the future. The UI supplies editable defaults; the API requires explicit sent timestamps.
- Allow early follow-ups: due dates guide bookkeeping, not permission to record a sent message. Reject follow-ups on closed sequences.
- To preserve sequence order, delete later messages before earlier ones. Deleting the only initial message removes its sequence.
- Deleting the second follow-up reopens an automatically completed sequence only if no newer sequence exists. Other closure reasons remain closed. Editing its timestamp updates automatic completion time.
- Corrections to historical sequences never reactivate them over a newer sequence. Recalculate derived state after every correction.

### Responses and persistence
- Writes return the affected company with refreshed derived state and `computedAt`; return `companyId` alongside that company. Creation returns `201`; other successful writes return `200`, including deletes.
- Errors use `{error: {code, message}}`: `400` for invalid input, `404` for missing records, and `409` for sequence/order conflicts.
- Serialize read-modify-write operations and atomically replace the JSON file. Confirm success only after persistence; return `500` on failure without reporting an unsaved change as successful.


## Implementation map

| Layer | Responsibility | Files |
| --- | --- | --- |
| HTTP | Define endpoints, select operations, and specify editable fields and success statuses. | `app/api/tracker/**/route.ts` |
| Orchestration | Parse and validate requests, coordinate logic and storage, and build HTTP responses and errors. | [`lib/tracker-api.ts`](../lib/tracker-api.ts) |
| Logic | Define data types, enforce business rules, and calculate outreach progress. | [`lib/tracker.ts`](../lib/tracker.ts) |
| Storage | Read JSON, queue updates, and atomically save data. | [`lib/tracker-storage.ts`](../lib/tracker-storage.ts) |

For writes, orchestration passes an edit callback to storage. Storage loads current data inside the queue, runs the callback using the logic layer, and saves before orchestration returns success.

Naming: `<feature>-api.ts` for HTTP helpers, `<feature>.ts` for logic, and `<feature>-storage.ts` for persistence. Tests live beside each file as `<name>.test.ts`. Next.js endpoints use `route.ts`.
