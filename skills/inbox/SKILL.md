---
name: inbox
description: Read requests the owner placed in HTML共有くん from a phone and start them on this computer. Use when the user says /inbox, $inbox, or asks to pick up phone requests.
---

# Inbox

Use the `html-share` CLI. Do not call the review API directly and do not print device tokens.

## 1. Read waiting requests

```bash
html-share review inbox
```

- `requests` are unfinished owner requests, oldest first
- `target` is a project nickname the owner typed on the phone. It may be `null`. Treat it as a hint, not a filesystem path
- If the array is empty, say there are no inbox requests and stop
- If the CLI says this computer is not paired, ask the owner to tap "Macを登録" in the inbox and run `/mobile pair <code>`

## 2. Claim each request before starting work on it, one at a time

```bash
html-share review claim <id>
```

- Claim oldest first. A successful claim moves the request to "in progress" and marks this
  computer as the owner — no other paired computer can complete it until you do
- A 409 means another computer already claimed that request first. Skip it and move to the
  next one. Do not start work on a request you failed to claim
- Only work on requests you successfully claimed
- Requests expire after 90 days, so do not leave them unread either

## 2b. Close a claimed request once its work is finished

```bash
html-share review complete <id>
```

- Complete only requests you claimed in step 2, and only after the work is actually done
  (unlike the old flow, claiming already marks the request as picked up — completing early
  is no longer needed to prevent other computers from re-picking it up)
- If the owner deletes a request you claimed, `complete` will fail — that is expected, not
  an error to retry. Say in chat that the request was withdrawn
- If you have to stop partway through, say so in chat. The request stays "in progress" under
  this computer until you complete it or the owner deletes it

## 3. Identify the starting folder

Requests from a phone often belong to different projects. Do not start everything in the current working directory.

- Pull 1–3 distinctive words from the request text. If `target` is present, search for that nickname first
- Look in nearby README / AGENTS.md files. Do not keep a hardcoded map of nicknames to folders
- If the folder is the current working directory, start here
- If it is a different folder, start a new session there and tell the owner you did so
- If one request spans two places, start from the folder you will write to
- If you cannot tell, ask with 2–3 candidates. Do not guess from recency or a similar name

## 4. Start the work

Treat each request as a normal user instruction.

- If there is one request, start it without asking which to do first
- If there are several, list them in one line each with the folder you chose, then start from the oldest
- Still confirm before sending, publishing, deleting, or spending money

## Related

- `/mobile` is the opposite direction: send a PC task to the phone and wait for a reply
