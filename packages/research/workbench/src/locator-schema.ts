/** The passage coordinates of an evidence source, shared by the command schema and the relation graph so that neither imports the other. */
import { z } from 'zod'

const integer = z.number().int().nonnegative()

/** Accepted passage coordinates for an evidence source; numeric coordinates must be nonnegative integers. */
export const locatorSchema = z.object({
  page: integer.optional(),
  paragraph: integer.optional(),
  line: integer.optional(),
  key: z.string().optional(),
})
