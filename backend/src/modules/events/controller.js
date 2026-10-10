export function createEventController({ eventService }) {
  return {
    async list(req, res) {
      const page = await eventService.listEvents(req.query);
      res.json(page);
    },

    async get(req, res) {
      const event = await eventService.getEvent(req.params.eventId);
      res.json({ data: event });
    },

    async quote(req, res) {
      const quote = await eventService.quote({ userId: req.userId }, req.params.eventId);
      res.json({ data: quote });
    },

    async book(req, res) {
      const result = await eventService.book(
        { userId: req.userId },
        req.params.eventId,
        req.body.expectedFinalPricePaise,
      );
      res.status(201).json({ data: result });
    },

    async checkIn(req, res) {
      const result = await eventService.checkIn({ userId: req.userId }, req.params.eventId, req.body.qrPayload);
      res.status(201).json({ data: result });
    },

    async create(req, res) {
      const event = await eventService.createEvent({ userId: req.userId }, req.params.clubId, req.body);
      res.status(201).json({ data: event });
    },

    async publish(req, res) {
      const event = await eventService.publish({ userId: req.userId }, req.params.eventId);
      res.json({ data: event });
    },
  };
}
