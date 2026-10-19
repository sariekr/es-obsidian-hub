use framework "Foundation"
use scripting additions

-- Local Apple Mail bridge. List reads metadata only; open requires one exact
-- account/mailbox/message identity. Nothing is written to disk or sent by mail.
on clipped(value, maxLength)
  if value is missing value then return ""
  set valueText to value as text
  if (count of valueText) > maxLength then return text 1 thru maxLength of valueText
  return valueText
end clipped

on encode(value)
  set jsonData to current application's NSJSONSerialization's dataWithJSONObject:value options:0 |error|:(missing value)
  return (current application's NSString's alloc()'s initWithData:jsonData encoding:(current application's NSUTF8StringEncoding)) as text
end encode

on run argv
  set probeStage to "arguments"
  try
    if (count of argv) = 5 and item 1 of argv = "open" then
      set targetAccount to item 2 of argv
      set targetMailbox to item 3 of argv
      set targetId to (item 4 of argv) as integer
      set targetHeader to item 5 of argv
      if targetId < 1 or (count of targetAccount) > 512 or (count of targetMailbox) > 512 or (count of targetHeader) > 2048 then error number -1700
      with timeout of 15 seconds
        tell application "Mail"
          set accountRef to first account whose id is targetAccount
          set boxRef to first mailbox of accountRef whose name is targetMailbox
          set messageRef to first message of boxRef whose id is targetId
          if (message id of messageRef) is not targetHeader then error number -1728
          open messageRef
          activate
        end tell
      end timeout
      return "{\"ok\":true}"
    end if
    if (count of argv) is not 1 or item 1 of argv is not "list" then error number -1700
    set probeStage to "foundation"
    set resultData to current application's NSMutableDictionary's dictionary()
    set accountData to current application's NSMutableArray's array()
    set messageData to current application's NSMutableArray's array()
    set probeStage to "clock"
    set referenceTime to current date
    set referenceEpoch to (current application's NSDate's |date|()'s timeIntervalSince1970()) as real
    with timeout of 20 seconds
      tell application "Mail"
        set probeStage to "accounts"
        set accountList to every account whose enabled is true
        if (count of accountList) > 20 then error number -2701
        repeat with accountRef in accountList
          set probeStage to "account-details"
          set accountId to id of accountRef
          set accountName to my clipped(name of accountRef, 256)
          set inboxRef to missing value
          repeat with boxRef in mailboxes of accountRef
            if name of boxRef is in {"INBOX", "Inbox", "Gelen Kutusu", "Gelen", "Gelenler"} then
              if inboxRef is not missing value then error number -2702
              set inboxRef to contents of boxRef
            end if
          end repeat
          if inboxRef is missing value then error number -2702
          set boxName to name of inboxRef
          set mailboxSize to count of messages of inboxRef
          set batchSize to mailboxSize
          if batchSize > 50 then set batchSize to 50
          set probeStage to "account-json"
          set accountRow to current application's NSMutableDictionary's dictionary()
          accountRow's setObject:accountId forKey:"id"
          accountRow's setObject:accountName forKey:"name"
          accountRow's setObject:(current application's NSNumber's numberWithBool:(mailboxSize > batchSize)) forKey:"limited"
          accountData's addObject:accountRow
          if batchSize > 0 then
            set probeStage to "metadata"
            set probeIds to id of messages 1 thru batchSize of inboxRef
            set probeSubjects to subject of messages 1 thru batchSize of inboxRef
            set probeSenders to sender of messages 1 thru batchSize of inboxRef
            set probeDates to date received of messages 1 thru batchSize of inboxRef
            set probeRead to read status of messages 1 thru batchSize of inboxRef
            set probeHeaders to message id of messages 1 thru batchSize of inboxRef
            set afterIds to id of messages 1 thru batchSize of inboxRef
            if probeIds is not afterIds then error number -2703
            if (count of probeSubjects) is not batchSize or (count of probeSenders) is not batchSize or (count of probeDates) is not batchSize or (count of probeRead) is not batchSize or (count of probeHeaders) is not batchSize then error number -2703
            repeat with i from 1 to batchSize
              set probeStage to "message-json"
              set rowData to current application's NSMutableDictionary's dictionary()
              rowData's setObject:(item i of probeIds) forKey:"id"
              rowData's setObject:accountId forKey:"accountId"
              rowData's setObject:boxName forKey:"mailbox"
              rowData's setObject:(my clipped(item i of probeSubjects, 1024)) forKey:"subject"
              rowData's setObject:(my clipped(item i of probeSenders, 512)) forKey:"sender"
              rowData's setObject:(my clipped(item i of probeHeaders, 2048)) forKey:"messageId"
              rowData's setObject:((referenceEpoch - (referenceTime - (item i of probeDates))) * 1000) forKey:"receivedAt"
              rowData's setObject:(current application's NSNumber's numberWithBool:(item i of probeRead)) forKey:"read"
              messageData's addObject:rowData
            end repeat
          end if
        end repeat
      end tell
    end timeout
    set probeStage to "serialize"
    resultData's setObject:1 forKey:"schema"
    resultData's setObject:accountData forKey:"accounts"
    resultData's setObject:messageData forKey:"rows"
    return my encode(resultData)
  on error ignoredText number errorNumber
    -- Never return Mail's raw error text: it can contain private message data.
    return "{\"ok\":false,\"code\":" & errorNumber & ",\"stage\":\"" & probeStage & "\"}"
  end try
end run
