
export function createEventReportService({ db }) {
  return {
    async getEventReport(eventId) {
      const event = await db('events').where({ id: eventId }).first();
      if (!event) return null;

      const ticketsSold = await db('tickets')
        .where({ event_id: eventId })
        .whereIn('status', ['VALID', 'USED'])
        .count('* as c')
        .first();

      const pendingBookings = await db('bookings')
        .where({ event_id: eventId, status: 'PENDING_PAYMENT' })
        .count('* as c')
        .first();

      const gross = await db('financial_transactions')
        .where({ event_id: eventId, category: 'TICKET_SALE' })
        .sum('amount_paise as s')
        .first();

      const checkedIn = await db('check_ins').where({ event_id: eventId }).count('* as c').first();

      const sold = Number(ticketsSold.c);
      const checked = Number(checkedIn.c);

      return {
        eventId,
        capacity: event.capacity,
        seatsReserved: event.seats_reserved,
        ticketsSold: sold,
        pendingBookings: Number(pendingBookings.c),
        remainingCapacity: event.capacity - event.seats_reserved,
        grossRecordedRevenuePaise: Number(gross.s ?? 0),
        netRecordedRevenuePaise: Number(gross.s ?? 0),
        checkedIn: checked,
        attendanceRate: sold > 0 ? checked / sold : null,
      };
    },
  };
}
