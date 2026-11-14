export async function collect(client) {
  const descriptor = await client('/descriptor');
  return descriptor.variables.map(variable => ({id:`${descriptor.revision}:${variable.name}`,name:variable.name,
    type:variable.type,dimensions:variable.dimensions,attributes:variable.attributes}));
}
