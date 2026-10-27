import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../src/infrastructure/http/http-identity.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {createHttpIdentity} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
globalThis.window = new EventTarget();
const user = {id:'test-user',email:'analyst@example.test',status:'ACTIVO',role:{id:'test-role',name:'PERITO'}};
test('browser uses same-origin cookies and never needs an access token', async () => {
 const calls=[];
 globalThis.fetch=async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/login')?{user}:[user]);};
 const identity=createHttpIdentity();await identity.login(user.email,'fixture-password');await identity.listUsers();
 assert.equal(calls[0].url,'/api/identity/auth/login');assert.equal(calls[1].options.credentials,'same-origin');assert.equal(calls[1].options.headers.Authorization,undefined);assert.equal(identity.current().id,user.id);assert.equal(identity.token,undefined);
});
test('a rejected session clears the current profile',async()=>{
 const identity=createHttpIdentity();identity.hydrate(user);
 globalThis.fetch=async()=>Response.json({detail:'Sesión expirada'},{status:401});
 await assert.rejects(identity.profile(),/Sesión expirada/);assert.equal(identity.current(),null);
});
test('denied management permissions do not erase an authenticated profile',async()=>{
 const identity=createHttpIdentity();identity.hydrate(user);
 globalThis.fetch=async()=>Response.json({detail:'Sin permisos'},{status:403});
 await assert.rejects(identity.listUsers(),/Sin permisos/);assert.equal(identity.current().id,user.id);
});
test('logout waits for server revocation',async()=>{
 const identity=createHttpIdentity();identity.hydrate(user);
 globalThis.fetch=async(url,options)=>{assert.equal(url,'/api/identity/auth/logout');assert.equal(options.method,'POST');return new Response(null,{status:204});};
 await identity.logout();assert.equal(identity.current(),null);
});
