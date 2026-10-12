# Axiom writers: every logToAxiom call and the field names it writes

Generated 2026-10-09 from main (a132952). Code-only. Built-ins on every event: _time, level, event, source.
FLAG column: SPREAD/VAR/NESTED = can add fields at run time.

| file:line | event | fields | flag |
|---|---|---|---|
| webhook.js:186 | 'hmac_signature_check' | mode, ok, reason, rejected, hasRawBody |  |
| webhook.js:239 | 'whatsapp_status_callback' |  | VAR detail |
| webhook.js:257 | 'router_route' | phone_number_id, destination, reason |  |
| webhook.js:263 | 'router_echo_unknown_number_id' | phone_number_id |  |
| webhook.js:278 | 'router_message_received' | phone, phone_number_id, text |  |
| webhook.js:285 | 'router_reaction_ignored' | phone, phone_number_id |  |
| webhook.js:292 | 'router_route' | phone, phone_number_id, destination, reason |  |
| webhook.js:299 | 'router_nontext_message' | phone, phone_number_id, messageType, lodgePhoneSource |  |
| webhook.js:316 | 'router_route' | phone, phone_number_id, destination, reason |  |
| webhook.js:331 | 'router_route' | phone, phone_number_id, destination, reason |  |
| webhook.js:337 | 'router_route' | phone, phone_number_id, destination, reason |  |
| webhook.js:346 | 'router_lead_choice' | phone, phone_number_id, choice |  |
| webhook.js:352 | 'router_lead_choice' | phone, phone_number_id, choice |  |
| webhook.js:357 | 'router_menu_reprompt' | phone, phone_number_id, received |  |
| webhook.js:363 | 'router_unknown' | phone, phone_number_id |  |
| webhook.js:377 | 'router_unknown_number_id' | phone, phone_number_id |  |
| webhook.js:382 | 'router_fatal' | phone, phone_number_id, error |  |
| wabistay/webhook.js:203 | 'airtable_call_count' | cronName, propertyCount, totalCalls, callsPerProperty, breakdown |  |
| wabistay/webhook.js:237 | 'airtable_get_error' | table, filterFormula, status, error |  |
| wabistay/webhook.js:264 | 'airtable_create_error' | table, status, error |  |
| wabistay/webhook.js:272 | 'airtable_create_success' | table, id |  |
| wabistay/webhook.js:292 | 'airtable_update_error' | table, recordId, status, error |  |
| wabistay/webhook.js:295 | 'airtable_update_success' | table, recordId |  |
| wabistay/webhook.js:314 | 'guest_state_write_failed' | guestId, fields, error | SPREAD ...logContext |
| wabistay/webhook.js:348 | 'guest_state_write_guard_tripped' | phone, guestId, targetState, errorType, guestMessageSent | SPREAD ...extra |
| wabistay/webhook.js:457 | 'wabistay_notify_phones' | notifyRouting, ownerPhoneLast4, notifyPhoneLast4, ownerReportPhoneLast4, propertyId |  |
| wabistay/webhook.js:477 | 'wabistay_flags' | flags, others | SPREAD ...where |
| wabistay/webhook.js:569 | 'cleaner_dispatch_template_failed' | to, template, error | SPREAD ...correlation |
| wabistay/webhook.js:576 | failEvent | error | SPREAD ...correlation |
| wabistay/webhook.js:602 | 'cleaner_gate_notify_no_cleaner' | reason | SPREAD ...correlation |
| wabistay/webhook.js:617 | 'cleaner_gate_notify_no_phone' | reason | SPREAD ...perCleaner |
| wabistay/webhook.js:629 | 'cleaner_gate_notify_stubbed' | to, params, reason | SPREAD ...perCleaner |
| wabistay/webhook.js:638 | 'cleaner_gate_notify_failed' | to, template, error | SPREAD ...perCleaner |
| wabistay/webhook.js:661 | 'reception_payment_notify_no_seat' | reason | SPREAD ...correlation |
| wabistay/webhook.js:680 | 'reception_payment_notify_stubbed' | to, params, reason | SPREAD ...perSeat |
| wabistay/webhook.js:689 | 'reception_payment_notify_failed' | to, template, error | SPREAD ...perSeat |
| wabistay/webhook.js:710 | 'reception_gate_notify_no_seat' | reason | SPREAD ...correlation |
| wabistay/webhook.js:725 | 'reception_gate_notify_stubbed' | to, params, reason | SPREAD ...perSeat |
| wabistay/webhook.js:734 | 'reception_gate_notify_failed' | to, template, error | SPREAD ...perSeat |
| wabistay/webhook.js:792 | 'gate_room_not_ready_owner_send_failed' | bookingId, error |  |
| wabistay/webhook.js:802 | 'gate_alert_unpaid_suppressed' | phone, bookingId, lastAlert |  |
| wabistay/webhook.js:842 | 'gate_alert_unpaid_owner_send_failed' | bookingId, error |  |
| wabistay/webhook.js:855 | 'gate_alert_stamp_write_failed' | bookingId, error |  |
| wabistay/webhook.js:859 | 'gate_alert_unpaid_sent' | phone, bookingId |  |
| wabistay/webhook.js:923 | 'new_booking_template_failed' | to, template, error | SPREAD ...correlation |
| wabistay/webhook.js:952 | 'whatsapp_send_error' | to, status, error |  |
| wabistay/webhook.js:961 | 'whatsapp_sent' | to, wamid |  |
| wabistay/webhook.js:1023 | 'whatsapp_template_send_error' | to, template, status, error | SPREAD ...correlation |
| wabistay/webhook.js:1032 | 'whatsapp_template_sent' | to, template, wamid | SPREAD ...correlation |
| wabistay/webhook.js:1052 | 'report_test_mode_redirect' | site, redirectedTo, intendedRecipient | SPREAD ...correlation |
| wabistay/webhook.js:1098 | 'alert_phone_multiple_rows' | rowCount, usedRowId |  |
| wabistay/webhook.js:1109 | 'alert_phone_fallback_used' | reason |  |
| wabistay/webhook.js:1112 | 'alert_phone_unavailable' | reason |  |
| wabistay/webhook.js:1121 | 'alert_shawn_no_destination' | cronName, errorMessage |  |
| wabistay/webhook.js:1146 | 'alert_shawn_template_send_failed' | cronName, errorMessage, error |  |
| wabistay/webhook.js:1152 | 'alert_shawn_template_not_configured' | cronName, reason |  |
| wabistay/webhook.js:1424 | 'owner_send_window_check' | site, recipient, inboundPhone, recipientIsInboundSender, likelyInside24hWindow |  |
| wabistay/webhook.js:1452 | 'property_resolution_failed' | phone_number_id |  |
| wabistay/webhook.js:1486 | 'property_activity_write_failed' | propertyId, field, error |  |
| wabistay/webhook.js:1489 | 'property_activity_write_failed' | propertyId, field, error |  |
| wabistay/webhook.js:1652 | 'enquiry_no_room_at_greeting' | phone, sastHour, stage, propertyId, sessionState | SPREAD ...(ctx.guest && ctx.guest.fields['Test Phone'] === true ? { testPhone: true } : {}) |
| wabistay/webhook.js:1667 | 'no_room_message_missing_redirect_phone' | propertyId |  |
| wabistay/webhook.js:1786 | 'hourly_expiry_write_failed' | bookingId, source, error |  |
| wabistay/webhook.js:1791 | 'hourly_booking_expired' | bookingId, bookingRef, roomId, source, bookingType, checkIn, minutesLate, testPhone |  |
| wabistay/webhook.js:1814 | 'hourly_expiry_notice_failed' | bookingId, error |  |
| wabistay/webhook.js:1817 | 'hourly_expiry_followup_failed' | bookingId, message |  |
| wabistay/webhook.js:1836 | 'cron_time_budget_hit' | cron, stage, leftFrom |  |
| wabistay/webhook.js:1841 | 'hourly_expiry_skipped_changed' | bookingId |  |
| wabistay/webhook.js:1921 | 'booking_superseded_write_failed' | bookingId, supersededBy, error |  |
| wabistay/webhook.js:1926 | 'booking_superseded' | bookingId, bookingRef, supersededBy, status |  |
| wabistay/webhook.js:1935 | 'booking_superseded_notice_failed' | supersededBy, error |  |
| wabistay/webhook.js:1937 | 'booking_supersede_failed' | phone, bookingId, message |  |
| wabistay/webhook.js:2346 | 'payment_reference_generation_exhausted' | existingCount |  |
| wabistay/webhook.js:2660 | 'escalation_alert_no_recipient' | propertyId |  |
| wabistay/webhook.js:2684 | 'escalation_alert_template_not_configured' | propertyId, tier, reason |  |
| wabistay/webhook.js:2694 | 'escalation_alert_send_failed' | propertyId, tier, roleId, error |  |
| wabistay/webhook.js:2699 | 'escalation_alert_sent' | propertyId, tier, roleId |  |
| wabistay/webhook.js:2845 | 'availability_check_failed_closed' | propertyId, checkInIso, checkOutIso, error, reason |  |
| wabistay/webhook.js:2937 | 'walkin_unauthorised_stranger' | phone |  |
| wabistay/webhook.js:2941 | 'walkin_unauthorised_deactivated' | phone, roleId |  |
| wabistay/webhook.js:2963 | 'paid_unauthorised_sender' | phone |  |
| wabistay/webhook.js:2982 | 'checkout_command_unauthorised_sender' | phone |  |
| wabistay/webhook.js:3004 | 'cleaning_start_unauthorised_sender' | phone |  |
| wabistay/webhook.js:3031 | 'done_left_to_guest_flow' | phone, sessionState |  |
| wabistay/webhook.js:3146 | 'cleaning_complete_room_not_cleaning' | phone, roomId, roomName, status, reason |  |
| wabistay/webhook.js:3181 | 'cleaner_done_room_status_write_failed' | phone, roomId, roomName, error |  |
| wabistay/webhook.js:3217 | 'cleaning_complete_lost_race_layer2' | phone, roomId, roomName, bookingId, ourCompletedAt, actualCompletedAt, reason |  |
| wabistay/webhook.js:3236 | 'cleaning_complete_no_booking' | phone, roomId, roomName, reason |  |
| wabistay/webhook.js:3243 | 'cleaning_job_completed' | phone, roomId, roomName, bookingId, bookingRef, cleanerId, cleanerName, completedAt, vacantToReadyMinutes, jobDurationMinutes, baselineSuspect, and dispatch is a broadcast |  |
| wabistay/webhook.js:3266 | 'state_transition' | phone, roomId, roomName, from, to, reason |  |
| wabistay/webhook.js:3276 | 'owner_room_cleaned_notify_failed' | roomId, error |  |
| wabistay/webhook.js:3295 | 'done_auto_checkin_failed' | roomId, message |  |
| wabistay/webhook.js:3321 | 'walkin_rejected' | phone, reason, requestedHours |  |
| wabistay/webhook.js:3326 | 'walkin_rejected' | phone, reason |  |
| wabistay/webhook.js:3330 | 'walkin_rejected' | phone, reason |  |
| wabistay/webhook.js:3343 | 'walkin_rejected' | phone, reason |  |
| wabistay/webhook.js:3354 | 'walkin_role_without_property' | phone, roleId |  |
| wabistay/webhook.js:3366 | 'walkin_property_mismatch' | phone, roleId, rolePropertyId, inboundPropertyId |  |
| wabistay/webhook.js:3391 | 'walkin_overnight_rate_lookup_not_singular' | phone, propertyId, matchCount |  |
| wabistay/webhook.js:3398 | 'walkin_rates_unavailable' | phone, propertyId |  |
| wabistay/webhook.js:3421 | 'walkin_rejected' | phone, reason, roomToken |  |
| wabistay/webhook.js:3433 | 'walkin_rejected' | phone, reason, roomToken, roomId |  |
| wabistay/webhook.js:3448 | 'walkin_room_mid_clean' | phone, roomId, roomName |  |
| wabistay/webhook.js:3462 | 'walkin_room_taken' | phone, roomId, roomName, checkIn, checkOut |  |
| wabistay/webhook.js:3504 | 'walkin_guest_create_failed' | phone, propertyId |  |
| wabistay/webhook.js:3548 | 'walkin_booking_create_failed' | phone, propertyId, roomId |  |
| wabistay/webhook.js:3562 | 'walkin_bookingref_writeback_failed' | phone, bookingId, bookingRef, error |  |
| wabistay/webhook.js:3582 | 'booking_rollback_failed' | phone, bookingId, roomId, error, reason |  |
| wabistay/webhook.js:3588 | 'walkin_rolled_back' | phone, bookingId, roomId, reason |  |
| wabistay/webhook.js:3604 | 'walkin_room_status_write_failed' | phone, roomId, bookingId, error |  |
| wabistay/webhook.js:3609 | 'booking_create' | phone, guestName, bookingRef, bookingType, source, hours, roomId, airtableId, roleId, propertyId, guestPhone |  |
| wabistay/webhook.js:3653 | 'pay_assigns_room_skipped' | bookingId, reason |  |
| wabistay/webhook.js:3666 | 'pay_assigns_room' | bookingId, outcome, guestSendError |  |
| wabistay/webhook.js:3690 | 'paid_rejected' | phone, reason |  |
| wabistay/webhook.js:3697 | 'paid_role_without_property' | phone, roleId |  |
| wabistay/webhook.js:3706 | 'paid_property_mismatch' | phone, roleId, rolePropertyId, inboundPropertyId |  |
| wabistay/webhook.js:3733 | 'paid_rejected' | phone, reason, refToken |  |
| wabistay/webhook.js:3739 | 'paid_property_mismatch' | phone, roleId, rolePropertyId, inboundPropertyId |  |
| wabistay/webhook.js:3755 | 'paid_rejected' | phone, reason, roomToken |  |
| wabistay/webhook.js:3773 | 'paid_rejected' | phone, reason, roomId |  |
| wabistay/webhook.js:3788 | 'paid_rejected' | phone, reason, roomId |  |
| wabistay/webhook.js:3801 | 'paid_already_recorded' | phone, bookingId, bookingRef, amountPaid |  |
| wabistay/webhook.js:3837 | 'payment_amount_mismatch' | phone, bookingId, bookingRef, roomName, amountSent, amountDue, delta, written |  |
| wabistay/webhook.js:3850 | 'payment_recorded_unpriced' | phone, bookingId, bookingRef, amountSent, reason |  |
| wabistay/webhook.js:3893 | 'payment_write_failed' | phone, roleId, propertyId, bookingId, bookingRef, amountAttempted, method, error |  |
| wabistay/webhook.js:3903 | 'payment_recorded' | phone, roleId, propertyId, bookingId, bookingRef, roomId, roomName, amountPaid, amountDue, method, status, recordedAt |  |
| wabistay/webhook.js:3924 | 'pay_assigns_room_failed' | bookingId, message |  |
| wabistay/webhook.js:3948 | 'checkout_command_rejected' | phone, reason |  |
| wabistay/webhook.js:3955 | 'checkout_command_role_without_property' | phone, roleId |  |
| wabistay/webhook.js:3960 | 'checkout_command_property_mismatch' | phone, roleId, rolePropertyId, inboundPropertyId |  |
| wabistay/webhook.js:3972 | 'checkout_command_rejected' | phone, reason, roomToken |  |
| wabistay/webhook.js:3980 | 'checkout_command_rejected' | phone, reason, roomId |  |
| wabistay/webhook.js:3992 | 'checkout_command_write_failed' | phone, bookingId, error |  |
| wabistay/webhook.js:4004 | 'checkout_command_room_status_write_failed' | phone, roomId, error |  |
| wabistay/webhook.js:4032 | 'checkout_command_recorded' | phone, roleId, propertyId, bookingId, bookingRef, roomId |  |
| wabistay/webhook.js:4059 | 'cleaning_start_rejected' | phone, roomToken, reason |  |
| wabistay/webhook.js:4071 | 'cleaning_start_no_booking' | phone, roomId, roomName |  |
| wabistay/webhook.js:4082 | 'cleaning_start_already_recorded' | phone, roomId, bookingId, startedAt |  |
| wabistay/webhook.js:4092 | 'cleaning_job_started' | phone, roomId, roomName, bookingId, bookingRef, cleanerId, cleanerName, startedAt |  |
| wabistay/webhook.js:4160 | 'property_unassigned_rows' | phone, propertyId, unassignedRoomCount, unassignedRateCount |  |
| wabistay/webhook.js:4173 | 'greeting_zero_rooms' | phone, propertyId |  |
| wabistay/webhook.js:4192 | 'guest_state_write_failed' | phone, fields, error | NESTED fields |
| wabistay/webhook.js:4242 | 'hourly_not_configured' | phone, propertyId |  |
| wabistay/webhook.js:4351 | 'booking_date_unparsed' | phone, checkInText, checkOutText |  |
| wabistay/webhook.js:4370 | 'booking_no_availability' | phone, propertyId, checkIn, checkOut |  |
| wabistay/webhook.js:4442 | 'booking_rollback_failed' | phone, bookingId, roomId, error, reason |  |
| wabistay/webhook.js:4455 | 'booking_race_lost' | phone, bookingId, roomId, checkIn, checkOut, reason |  |
| wabistay/webhook.js:4473 | 'collectdetails_bookingref_writeback_failed' | phone, bookingId, bookingRef, error |  |
| wabistay/webhook.js:4483 | 'booking_create' | phone, guestName, bookingRef, airtableId, error |  |
| wabistay/webhook.js:4525 | 'overnight_rate_lookup_not_singular' | phone, propertyId, bookingId, matchCount |  |
| wabistay/webhook.js:4537 | 'overnight_rate_write_failed' | phone, bookingId, amount, error |  |
| wabistay/webhook.js:4574 | 'owner_new_booking_notify_failed' | bookingId, error |  |
| wabistay/webhook.js:4606 | 'hourly_not_configured' | phone, propertyId |  |
| wabistay/webhook.js:4621 | 'guest_state_write_failed' | phone, fields, error | NESTED fields |
| wabistay/webhook.js:4646 | 'guest_state_write_failed' | phone, fields, error | NESTED fields |
| wabistay/webhook.js:4765 | 'hourly_booking_write_failed' | phone, guestName, error |  |
| wabistay/webhook.js:4800 | 'hourly_redirect_cancel_failed' | phone, bookingId, error |  |
| wabistay/webhook.js:4806 | 'hourly_redirect_overnight' | phone, requestedHours |  |
| wabistay/webhook.js:4818 | 'hourly_one_hour_hidden_reply' | phone |  |
| wabistay/webhook.js:4841 | 'hourly_no_availability' | phone, propertyId, checkIn, checkOut |  |
| wabistay/webhook.js:4888 | 'hourly_confirm_write_failed' | phone, bookingId, roomId, amount, error |  |
| wabistay/webhook.js:4907 | 'booking_rollback_failed' | phone, bookingId, roomId, error, reason |  |
| wabistay/webhook.js:4917 | 'booking_race_lost' | phone, bookingId, roomId, checkIn, checkOut, reason |  |
| wabistay/webhook.js:4929 | 'booking_create' | phone, guestName, bookingRef, bookingType, hours, airtableId |  |
| wabistay/webhook.js:4963 | 'owner_hourly_booking_notify_failed' | bookingId, error |  |
| wabistay/webhook.js:5031 | 'payment_method_write_failed' | phone, bookingId, method, error |  |
| wabistay/webhook.js:5053 | 'payment_reference_write_failed' | phone, bookingId, reference, error |  |
| wabistay/webhook.js:5104 | 'eta_confirm_write_failed' | phone, bookingId, error |  |
| wabistay/webhook.js:5130 | 'state_transition' | phone, guestId, from, to, eta |  |
| wabistay/webhook.js:5159 | 'gate_arrival_booking_expired' | phone, guestId, releasedAtTap |  |
| wabistay/webhook.js:5166 | 'gate_arrival_no_booking' | phone, guestId |  |
| wabistay/webhook.js:5187 | 'gate_arrival_too_early' | phone, bookingId, checkIn |  |
| wabistay/webhook.js:5215 | 'gate_arrival_payment_not_confirmed' | phone, bookingId, amountDue |  |
| wabistay/webhook.js:5230 | 'gate_alert_unpaid_failed' | phone, bookingId, message |  |
| wabistay/webhook.js:5243 | 'gate_tap_stamp_write_failed' | bookingId, error |  |
| wabistay/webhook.js:5246 | 'gate_tap_stamp_write_failed' | bookingId, message |  |
| wabistay/webhook.js:5264 | 'held_room_reassigned' | phone, bookingId, heldRoomId, reassignedTo, reason |  |
| wabistay/webhook.js:5269 | 'held_room_lost_no_alternative' | phone, bookingId, heldRoomId |  |
| wabistay/webhook.js:5290 | 'gate_room_not_ready' | phone, bookingId, roomId, roomName, roomStatus, heldRoomId, held |  |
| wabistay/webhook.js:5300 | 'gate_room_not_ready_alert_failed' | phone, bookingId, message |  |
| wabistay/webhook.js:5321 | 'gate_arrival_room_status_write_failed' | phone, roomId, error |  |
| wabistay/webhook.js:5352 | 'gate_arrival_skipped_already_checked_in' | phone, bookingId, currentStatus |  |
| wabistay/webhook.js:5372 | 'gate_arrival_checkin_write_failed' | phone, bookingId, error |  |
| wabistay/webhook.js:5383 | 'state_transition' | phone, guestId, from, to, assignedRoom |  |
| wabistay/webhook.js:5400 | 'gate_arrival_notify_failed' | bookingId, error |  |
| wabistay/webhook.js:5447 | 'checkout_button_welcome_fell_back' | phone, error |  |
| wabistay/webhook.js:5468 | 'cancel_booking_write_failed' | phone, bookingId, error |  |
| wabistay/webhook.js:5476 | 'state_transition' | phone, guestId, from, to, reason |  |
| wabistay/webhook.js:5509 | 'checkout_ignored_after_auto_checkin' | phone, bookingId, minutesSince |  |
| wabistay/webhook.js:5542 | 'checkout_write_failed' | phone, bookingId, error |  |
| wabistay/webhook.js:5563 | 'checkout_room_status_write_failed' | phone, roomId, error |  |
| wabistay/webhook.js:5609 | 'state_transition' | phone, guestId, from, to, reason, roomName |  |
| wabistay/webhook.js:5635 | 'rating_write_failed' | phone, bookingId, rating, error |  |
| wabistay/webhook.js:5643 | 'rating_no_booking_found' | phone, guestId, rating |  |
| wabistay/webhook.js:5648 | 'state_transition' | phone, guestId, from, to, rating |  |
| wabistay/webhook.js:5654 | 'state_transition' | phone, guestId, from, to, rating |  |
| wabistay/webhook.js:5678 | 'state_transition' | phone, guestId, from, to, reason |  |
| wabistay/webhook.js:5687 | 'rating_feedback_write_failed' | phone, bookingId, error |  |
| wabistay/webhook.js:5692 | 'rating_feedback_no_booking_found' | phone, guestId |  |
| wabistay/webhook.js:5695 | 'state_transition' | phone, guestId, from, to |  |
| wabistay/webhook.js:5708 | 'guest_message_suppressed_human_handling' | phone, guestId, text |  |
| wabistay/webhook.js:5724 | 'checkout_ask_fell_back' | phone, error |  |
| wabistay/webhook.js:5748 | 'extend_refused_day_booking' | phone, bookingId |  |
| wabistay/webhook.js:5782 | 'extend_duplicate_wamid_suspected' | phone, bookingId, wamid |  |
| wabistay/webhook.js:5818 | 'extension_not_priced' | phone, bookingId, bookingType, propertyId, amountDue |  |
| wabistay/webhook.js:5834 | 'extend_duplicate_delivery_suspected' | phone, bookingId, readCheckOut, currentCheckOut |  |
| wabistay/webhook.js:5850 | 'extend_write_failed' | phone, bookingId, error |  |
| wabistay/webhook.js:5868 | 'owner_extension_notify_failed' | bookingId, error |  |
| wabistay/webhook.js:5873 | 'booking_extended' | phone, bookingId, newCheckOut, ownerNotified, so "what did this extension cost and what is owed now" is a, amountDue |  |
| wabistay/webhook.js:5934 | 'auto_checkout_skipped_already_settled' | bookingId, currentStatus |  |
| wabistay/webhook.js:5950 | 'auto_checkout_write_failed' | bookingId, error |  |
| wabistay/webhook.js:5962 | 'auto_checkout_room_status_write_failed' | roomId, error |  |
| wabistay/webhook.js:6073 | 'cron_time_budget_hit' | cron, stage, leftFrom |  |
| wabistay/webhook.js:6079 | 'hold_expired_paid_skipped' | bookingId, holdExpiresAt |  |
| wabistay/webhook.js:6087 | 'hold_release_skipped_changed' | bookingId, currentStatus |  |
| wabistay/webhook.js:6095 | 'hold_release_write_failed' | bookingId, error |  |
| wabistay/webhook.js:6100 | 'hold_released' | bookingId, bookingRef, roomId, status, holdExpiresAt |  |
| wabistay/webhook.js:6124 | 'hold_expired_enquiry_not_logged' | bookingId, reason |  |
| wabistay/webhook.js:6159 | 'cron_time_budget_hit' | cron, stage, leftFrom |  |
| wabistay/webhook.js:6176 | 'overdue_alert_no_seat' | reason | SPREAD ...correlation |
| wabistay/webhook.js:6192 | 'overdue_alert_failed' | to, template, error | SPREAD ...correlation |
| wabistay/webhook.js:6199 | 'overdue_alert_stamp_write_failed' | bookingId, error |  |
| wabistay/webhook.js:6201 | 'overdue_alert_sent' | checkOut | SPREAD ...correlation |
| wabistay/webhook.js:6235 | 'cron_time_budget_hit' | cron, stage, leftFrom |  |
| wabistay/webhook.js:6250 | 'unattended_gate_arrival' | testPhone | SPREAD ...event |
| wabistay/webhook.js:6255 | 'unattended_gate_marker_write_failed' | bookingId, error |  |
| wabistay/webhook.js:6258 | 'unattended_gate_arrival' | testPhone | SPREAD ...event |
| wabistay/webhook.js:6290 | 'cron_time_budget_hit' | cron, stage, leftFrom |  |
| wabistay/webhook.js:6321 | 'checkout_warning_stamp_write_failed' | bookingId, error |  |
| wabistay/webhook.js:6326 | 'auto_checkout_warning' | bookingId, phone, checkOut |  |
| wabistay/webhook.js:6345 | 'auto_checkout_fired' | bookingId, phone |  |
| wabistay/webhook.js:6442 | 'enquiry_skipped_test_phone' | phone, outcome |  |
| wabistay/webhook.js:6443 | 'enquiry_closed' | testPhone | SPREAD ...closed |
| wabistay/webhook.js:6474 | 'enquiry_log_write_failed' | phone, propertyId, outcome, error |  |
| wabistay/webhook.js:6477 | 'enquiry_logged' | phone, propertyId, outcome, bookingType, upgradedFrom |  |
| wabistay/webhook.js:6478 | 'enquiry_closed' | testPhone | SPREAD ...closed |
| wabistay/webhook.js:6506 | 'enquiry_log_write_failed' | phone, propertyId, outcome, error |  |
| wabistay/webhook.js:6511 | 'enquiry_logged' | phone, propertyId, outcome, bookingType |  |
| wabistay/webhook.js:6512 | 'enquiry_closed' | testPhone | SPREAD ...closed |
| wabistay/webhook.js:6578 | 'cron_time_budget_hit' | cron, stage, leftFrom |  |
| wabistay/webhook.js:6591 | 'enquiry_abandoned' | phone, guestId, sessionState |  |
| wabistay/webhook.js:6639 | 'cron_started' | cron |  |
| wabistay/webhook.js:6659 | 'cron_duration' | cron, ms, truncated |  |
| wabistay/webhook.js:6671 | 'auto_checkout_fatal' | message, stack |  |
| wabistay/webhook.js:6819 | 'owner_summary_payload' |  | VAR payload |
| wabistay/webhook.js:7225 | 'monthly_report_payload' |  | VAR payload |
| wabistay/webhook.js:7262 | 'report_skipped_unnamed_property' | cron, propertyId |  |
| wabistay/webhook.js:7305 | 'monthly_report_property_failed' | propertyId, propertyName, message, stack |  |
| wabistay/webhook.js:7323 | 'cron_started' | cron |  |
| wabistay/webhook.js:7330 | 'cron_duration' | cron, ms |  |
| wabistay/webhook.js:7334 | 'monthly_report_fatal' | message, stack |  |
| wabistay/webhook.js:7388 | 'owner_summary_property_failed' | propertyId, propertyName, message, stack |  |
| wabistay/webhook.js:7419 | 'owner_summary_fatal' | message, stack |  |
| wabistay/webhook.js:7754 | 'daily_summary_payload' |  | VAR payload |
| wabistay/webhook.js:7855 | 'weekly_recap_payload' |  | VAR payload |
| wabistay/webhook.js:7902 | 'weekly_recap_property_failed' | propertyId, propertyName, message, stack |  |
| wabistay/webhook.js:7923 | 'weekly_recap_fatal' | message, stack |  |
| wabistay/webhook.js:7993 | 'daily_summary_property_failed' | propertyId, propertyName, message, stack |  |
| wabistay/webhook.js:8017 | 'daily_summary_fatal' | message, stack |  |
| wabistay/webhook.js:8052 | 'message_echo_no_guest' | guestPhone |  |
| wabistay/webhook.js:8063 | 'bot_on_no_op' | guestPhone, guestId, currentState |  |
| wabistay/webhook.js:8067 | 'human_handback' | guestPhone, guestId |  |
| wabistay/webhook.js:8074 | 'human_handoff' | guestPhone, guestId, fromState |  |
| wabistay/webhook.js:8132 | 'after_hours_message' | phone, sastHour, sessionState |  |
| wabistay/webhook.js:8143 | 'after_hours_welcome_sent' | phone, tomorrow |  |
| wabistay/webhook.js:8154 | 'after_hours_stamp_failed' | phone, error |  |
| wabistay/webhook.js:8156 | 'after_hours_stamp_failed' | phone, message |  |
| wabistay/webhook.js:8330 | 'stay_menu_reprompt' | phone, reply, choice, offered |  |
| wabistay/webhook.js:8348 | 'stay_menu_choice_write_failed' | phone, product, error |  |
| wabistay/webhook.js:8355 | 'stay_menu_choice' | phone, product, offered |  |
| wabistay/webhook.js:8424 | 'stay_menu_arrival_refused' | phone, product, reason |  |
| wabistay/webhook.js:8442 | 'stay_menu_unpriced' | phone, product, propertyId |  |
| wabistay/webhook.js:8450 | 'stay_menu_no_availability' | phone, product, checkIn, checkOut |  |
| wabistay/webhook.js:8466 | 'stay_menu_confirm_write_failed' | phone, bookingId, roomId, amount, error |  |
| wabistay/webhook.js:8476 | 'booking_rollback_failed' | phone, bookingId, roomId, error, reason |  |
| wabistay/webhook.js:8482 | 'booking_race_lost' | phone, bookingId, roomId, checkIn, checkOut |  |
| wabistay/webhook.js:8488 | 'booking_create' | phone, guestName, bookingRef, bookingType, stay, airtableId |  |
| wabistay/webhook.js:8510 | 'owner_stay_menu_booking_notify_failed' | bookingId, error |  |
| wabistay/webhook.js:8539 | 'message_dedupe_write_failed' | phone, wamid, guestId, error |  |
| wabistay/webhook.js:8542 | 'message_dedupe_write_failed' | phone, wamid, guestId, message |  |
| wabistay/webhook.js:8614 | 'interactive_invalid' | to, reason |  |
| wabistay/webhook.js:8633 | 'interactive_send_error' | to, status, error |  |
| wabistay/webhook.js:8635 | 'interactive_sent' | to, wamid, buttons |  |
| wabistay/webhook.js:8655 | 'interactive_fallback_text' | phone, menu, reason, error |  |
| wabistay/webhook.js:8672 | 'message_received' | phone, text, sessionState |  |
| wabistay/webhook.js:8692 | 'duplicate_message_skipped' | phone, wamid, guestId, sessionState |  |
| wabistay/webhook.js:8698 | 'message_received' | phone, text, sessionState | SPREAD ...(isTestGuest(guest) ? { testPhone: true } : {}); SPREAD ...(interactive ? { interactiveId: interactive.id, int |
| wabistay/webhook.js:8706 | 'interactive_reply_received' | phone, replyId, title, sessionState, mapped |  |
| wabistay/webhook.js:8718 | 'checkout_button_tap_ignored' | phone, replyId, sessionState |  |
| wabistay/webhook.js:8760 | 'stop_ignored_staff_number' | phone |  |
| wabistay/webhook.js:8784 | 'guest_opt_out_write_failed' | phone, error |  |
| wabistay/webhook.js:8790 | 'guest_opted_out' | phone, activeBooking |  |
| wabistay/webhook.js:8803 | 'guest_opt_in_write_failed' | phone, error |  |
| wabistay/webhook.js:8809 | 'guest_opted_back_in' | phone |  |
| wabistay/webhook.js:8819 | 'opted_out_optional_suppressed' | phone, sessionState |  |
| wabistay/webhook.js:8825 | 'opted_out_transaction_allowed' | phone, sessionState |  |
| wabistay/webhook.js:8871 | 'suspended_property_missing_redirect_phone' | phone, propertyId, sessionState |  |
| wabistay/webhook.js:8891 | 'booking_blocked_property_suspended' | phone, propertyId, sessionState |  |
| wabistay/webhook.js:8919 | 'popia_consent_sent' | phone |  |
| wabistay/webhook.js:9025 | 'whatsapp_status_callback' |  | VAR detail |
| wabistay/webhook.js:9035 | 'owner_app_open_lookup_failed' | recipient, error |  |
| wabistay/webhook.js:9051 | 'message_echo_handling_failed' | echoId, error |  |
| wabistay/webhook.js:9091 | 'fatal' | message, stack |  |
| wabiprop/webhook.js:269 | 'flow1_start' | phone, msg |  |
| wabiprop/webhook.js:282 | 'flow1_tenant_fields' | phone, tenantName, unitAddress, propertyName, agentPhone, ownerPhone |  |
| wabiprop/webhook.js:303 | 'flow1_issue_create_attempt' | phone, issueTitle |  |
| wabiprop/webhook.js:307 | 'flow1_issue_create_failed' | phone, error |  |
| wabiprop/webhook.js:314 | 'flow1_issue_created' | phone, issueRef, airtableId |  |
| wabiprop/webhook.js:323 | 'flow1_tenant_ack_attempt' | phone, issueRef |  |
| wabiprop/webhook.js:325 | 'flow1_tenant_ack_result' | phone, issueRef, metaError, messageId |  |
| wabiprop/webhook.js:334 | 'flow1_no_agent_phone' | phone, tenantName |  |
| wabiprop/webhook.js:345 | 'flow1_agent_notify_attempt' | phone, agentPhone, issueRef |  |
| wabiprop/webhook.js:347 | 'flow1_agent_notify_result' | phone, agentPhone, issueRef, metaError, messageId |  |
| wabiprop/webhook.js:355 | 'flow1_complete' | phone, issueRef, tenantName |  |
| wabiprop/webhook.js:359 | 'flow1_error' | phone, error |  |
| wabiprop/webhook.js:427 | 'flow_t1_intake_started' | phone, issueId |  |
| wabiprop/webhook.js:432 | 'flow_t1_start_error' | phone, error |  |
| wabiprop/webhook.js:475 | 'flow_t1_no_agent_phone' | phone, tenantName |  |
| wabiprop/webhook.js:479 | 'flow_t1_complete' | phone, issueRef, tenantName |  |
| wabiprop/webhook.js:483 | 'flow_t1_complete_error' | phone, error |  |
| wabiprop/webhook.js:545 | 'flow_t2_no_agent_phone' | phone, tenantName |  |
| wabiprop/webhook.js:549 | 'flow_t2_complete' | phone, issueRef, tenantName |  |
| wabiprop/webhook.js:553 | 'flow_t2_error' | phone, error |  |
| wabiprop/webhook.js:610 | 'flow_t3_enquiry_started' | phone, issueId |  |
| wabiprop/webhook.js:615 | 'flow_t3_start_error' | phone, error |  |
| wabiprop/webhook.js:647 | 'flow_t3_no_agent_phone' | phone, tenantName |  |
| wabiprop/webhook.js:651 | 'flow_t3_complete' | phone, issueRef, tenantName |  |
| wabiprop/webhook.js:655 | 'flow_t3_complete_error' | phone, error |  |
| wabiprop/webhook.js:711 | 'agent_open_issues_list' | phone, count |  |
| wabiprop/webhook.js:923 | 'agent_attend' | phone, issueRef |  |
| wabiprop/webhook.js:993 | 'agent_attended' | phone, issueRef |  |
| wabiprop/webhook.js:1079 | 'agent_escalate_no_owner_phone' | phone, issueRef |  |
| wabiprop/webhook.js:1088 | 'agent_escalate_to_owner' | phone, issueRef, ownerNotified |  |
| wabiprop/webhook.js:1105 | 'flow2c_start' | phone, contractorName |  |
| wabiprop/webhook.js:1152 | 'flow2c_complete' | phone, contractorName, issueRef |  |
| wabiprop/webhook.js:1156 | 'flow2c_error' | phone, error |  |
| wabiprop/webhook.js:1170 | 'flow3_start' | phone, contractorName |  |
| wabiprop/webhook.js:1232 | 'flow3_complete' | phone, contractorName, issueRef |  |
| wabiprop/webhook.js:1236 | 'flow3_error' | phone, error |  |
| wabiprop/webhook.js:1250 | 'flow4_start' | phone, contractorName |  |
| wabiprop/webhook.js:1305 | 'flow4_complete' | phone, contractorName, issueRef |  |
| wabiprop/webhook.js:1309 | 'flow4_error' | phone, error |  |
| wabiprop/webhook.js:1341 | `flow4${confirmed ? 'b' : 'c'}_start` | phone, confirmed, issueRef |  |
| wabiprop/webhook.js:1367 | 'flow4b_complete' | phone, issueRef, result |  |
| wabiprop/webhook.js:1384 | 'flow4c_awaiting_detail' | phone, issueRef |  |
| wabiprop/webhook.js:1389 | 'flow4bc_error' | phone, error |  |
| wabiprop/webhook.js:1413 | 'flow4d_detail_received' | phone, issueRef |  |
| wabiprop/webhook.js:1427 | 'flow4d_awaiting_confirm' | phone, issueRef |  |
| wabiprop/webhook.js:1431 | 'flow4d_error' | phone, error |  |
| wabiprop/webhook.js:1457 | 'flow4e_start' | phone, issueRef, reply |  |
| wabiprop/webhook.js:1468 | 'flow4e_loop_more' | phone, issueRef |  |
| wabiprop/webhook.js:1499 | 'flow4e_complete' | phone, issueRef, result |  |
| wabiprop/webhook.js:1506 | 'flow4e_reprompt' | phone, issueRef |  |
| wabiprop/webhook.js:1511 | 'flow4e_error' | phone, error |  |
| wabiprop/webhook.js:1554 | 'agent_status_check' | phone, issueRef |  |
| wabiprop/webhook.js:1621 | 'agent_stale_check' | phone, staleCount, refs |  |
| wabiprop/webhook.js:1694 | 'tenant_register_code_not_found' | phone, code |  |
| wabiprop/webhook.js:1707 | 'tenant_register_code_already_claimed' | phone, code, unitId |  |
| wabiprop/webhook.js:1732 | 'tenant_register_no_agent_phone' | phone, code, unitId |  |
| wabiprop/webhook.js:1735 | 'tenant_register_pending' | phone, code, unitId, agentNotified |  |
| wabiprop/webhook.js:1765 | 'tenant_register_approve_wrong_agent' | phone, code, unitId |  |
| wabiprop/webhook.js:1790 | 'tenant_register_approved' | phone, code, unitId, tenantId, pendingPhone |  |
| wabiprop/webhook.js:1834 | 'tenant_register_rejected' | phone, code, unitId, pendingPhone |  |
| wabiprop/webhook.js:1848 | 'message_received' | phone, text |  |
| wabiprop/webhook.js:1851 | 'sender_identified' | phone, role |  |
| wabiprop/webhook.js:2006 | 'tenant_session_expired' | phone |  |
| wabiprop/webhook.js:2183 | 'delivery_status' | message_id, recipient, status, errors |  |
| wabiprop/cron/agent-morning-summary.js:118 | 'agent_morning_summary_sent' | agentPhone, openCount, staleCount, callRequestedCount, metaError |  |
| wabiprop/cron/agent-morning-summary.js:128 | 'agent_morning_summary_error' | agentPhone, error |  |
| wabiprop/cron/call-reminder.js:110 | 'call_reminder_sent' | issueId, issueRef, agentPhone, hoursAgo, metaError |  |
| wabiprop/cron/call-reminder.js:120 | 'call_reminder_error' | issueId, error |  |
| wabiprop/cron/lease-reminders.js:142 | 'lease_reminder_digest_sent' | agentPhone, leaseCount, metaError |  |
| wabiprop/cron/owner-weekly.js:135 | 'owner_weekly_report_sent' | ownerPhone, monthName, rentalIncome, maintenanceSpend, propertyCount, tenantCount, metaError |  |
| wabiprop/cron/owner-weekly.js:146 | 'owner_weekly_report_error' | ownerPhone, error |  |
| wabiprop/cron/rent-reminders.js:127 | 'rent_reminder_sent' | leaseId, tenantId, phone, daysUntil, dueDate, metaError |  |
