export function behavior(entry,state,fixture,scenario) {
if (entry.path !== '/subset' || entry.method !== 'POST') return null;
const descriptor = [...(fixture.cases[scenario] ?? []),...fixture.exchanges].find(route => route.path === '/descriptor').body;
if (entry.body?.descriptorRevision !== descriptor.revision) return {status:412,body:{error:'descriptor changed'}};
if (!Array.isArray(entry.body?.projection) || entry.body.projection.some(item => !descriptor.allowedNames.includes(item.name))) return {status:403,body:{error:'projection outside consent'}};
return null;
}
