// Parser smoke test on tiny hand-written fixtures (no network, no DB).
import assert from "node:assert/strict";
import { parseUN, parseEU, parseUK, parseOFAC, parseOFACCrypto, normalizeAddress } from "./sanctions-lists.js";

const un = parseUN(`<CONSOLIDATED_LIST><INDIVIDUALS>
 <INDIVIDUAL><DATAID>1</DATAID><FIRST_NAME>Ali</FIRST_NAME><SECOND_NAME>Hassan</SECOND_NAME><THIRD_NAME>Khan</THIRD_NAME>
  <UN_LIST_TYPE>Al-Qaida</UN_LIST_TYPE><REFERENCE_NUMBER>QDi.001</REFERENCE_NUMBER>
  <INDIVIDUAL_ALIAS><QUALITY>Good</QUALITY><ALIAS_NAME>Abu Ali</ALIAS_NAME></INDIVIDUAL_ALIAS>
  <INDIVIDUAL_ALIAS><ALIAS_NAME></ALIAS_NAME></INDIVIDUAL_ALIAS>
  <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>EXACT</TYPE_OF_DATE><DATE>1970-02-03</DATE></INDIVIDUAL_DATE_OF_BIRTH>
  <NATIONALITY><VALUE>Pakistan</VALUE></NATIONALITY></INDIVIDUAL></INDIVIDUALS>
 <ENTITIES><ENTITY><DATAID>2</DATAID><FIRST_NAME>Acme Front Co</FIRST_NAME><UN_LIST_TYPE>DPRK</UN_LIST_TYPE>
  <REFERENCE_NUMBER>KPe.001</REFERENCE_NUMBER><ENTITY_ALIAS><ALIAS_NAME>Acme Trading</ALIAS_NAME></ENTITY_ALIAS></ENTITY></ENTITIES>
</CONSOLIDATED_LIST>`);
assert.equal(un.length, 2);
assert.deepEqual(un[0], { uid: "QDi.001", name: "Ali Hassan Khan", type: "Individual", dob: "1970-02-03",
  nationality: "Pakistan", program: "Al-Qaida", aliases: ["Abu Ali"] });
assert.equal(un[1].type, "Entity"); assert.equal(un[1].aliases[0], "Acme Trading");

const eu = parseEU(`<export><sanctionEntity logicalId="9" euReferenceNumber="EU.1.23">
 <subjectType code="person"/><regulation programme="RUS"/><regulation programme="RUS"/>
 <nameAlias wholeName="Ivan Petrov"/><nameAlias firstName="Vanya" lastName="Petrov"/>
 <birthdate birthdate="1965-01-22"/><citizen countryDescription="RUSSIAN FEDERATION"/></sanctionEntity>
 <sanctionEntity logicalId="10"><subjectType code="enterprise"/><nameAlias wholeName="Foo LLC"/></sanctionEntity></export>`);
assert.equal(eu.length, 2);
assert.deepEqual(eu[0], { uid: "EU.1.23", name: "Ivan Petrov", type: "Individual", dob: "1965-01-22",
  nationality: "RUSSIAN FEDERATION", program: "RUS", aliases: ["Vanya Petrov"] });
assert.equal(eu[1].uid, "10"); assert.equal(eu[1].type, "Entity");

const uk = parseUK(`<Designations><Designation><UniqueID>RUS0001</UniqueID><RegimeName>Russia</RegimeName>
 <IndividualEntityShip>Individual</IndividualEntityShip>
 <Names><Name><Name1>Ivan</Name1><Name6>PETROV</Name6><NameType>Primary Name</NameType></Name>
        <Name><Name6>Vanya Petrov</Name6><NameType>Alias</NameType></Name></Names>
 <IndividualDetails><DOBs><DOB>22/01/1965</DOB></DOBs><Nationalities><Nationality>Russia</Nationality></Nationalities></IndividualDetails>
 </Designation></Designations>`);
assert.equal(uk.length, 1);
assert.equal(uk[0].name, "Ivan PETROV"); assert.equal(uk[0].aliases[0], "Vanya Petrov");
assert.equal(uk[0].dob, "1965-01-22");
const ofac = parseOFAC(`<sdnList><publshInformation><Publish_Date>10/01/2026</Publish_Date></publshInformation>
 <sdnEntry><uid>36</uid><lastName>AEROCARIBBEAN AIRLINES</lastName><sdnType>Entity</sdnType>
  <programList><program>CUBA</program></programList>
  <akaList><aka><uid>12</uid><type>a.k.a.</type><lastName>AERO-CARIBBEAN</lastName></aka></akaList></sdnEntry>
 <sdnEntry><uid>2674</uid><firstName>Viktor</firstName><lastName>PETROV</lastName><sdnType>Individual</sdnType>
  <programList><program>RUSSIA-EO14024</program><program>UKRAINE-EO13662</program></programList>
  <dateOfBirthList><dateOfBirthItem><uid>1</uid><dateOfBirth>22 Jan 1965</dateOfBirth></dateOfBirthItem></dateOfBirthList>
  <nationalityList><nationality><uid>2</uid><country>Russia</country></nationality></nationalityList></sdnEntry></sdnList>`);
assert.equal(ofac.length, 2);
assert.deepEqual(ofac[0], { uid: "36", name: "AEROCARIBBEAN AIRLINES", type: "Entity", dob: null,
  nationality: null, program: "CUBA", aliases: ["AERO-CARIBBEAN"] });
assert.deepEqual(ofac[1], { uid: "2674", name: "Viktor PETROV", type: "Individual", dob: "22 Jan 1965",
  nationality: "Russia", program: "RUSSIA-EO14024,UKRAINE-EO13662", aliases: [] });
console.log("parsers OK");

// OFAC sdn_advanced.xml: crypto addresses, every asset type, linked to the party.
const adv = parseOFACCrypto(`<?xml version="1.0"?>
<Sanctions xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADVANCED_XML">
 <DateOfIssue><Year>2026</Year><Month>10</Month><Day>9</Day></DateOfIssue>
 <ReferenceValueSets><FeatureTypeValues>
  <FeatureType ID="8" FeatureTypeGroupID="1">Nationality Country</FeatureType>
  <FeatureType ID="344" FeatureTypeGroupID="1">Digital Currency Address - XBT</FeatureType>
  <FeatureType ID="345" FeatureTypeGroupID="1">Digital Currency Address - ETH</FeatureType>
  <FeatureType ID="999" FeatureTypeGroupID="1">Digital Currency Address - DOGE</FeatureType>
 </FeatureTypeValues></ReferenceValueSets>
 <DistinctParties>
  <DistinctParty FixedRef="41287"><Profile ID="41287" PartySubTypeID="4">
   <Identity ID="1" FixedRef="41287" Primary="true" False="false">
    <Alias FixedRef="41287" AliasTypeID="1400" Primary="false" LowQuality="false"><DocumentedName ID="2"><DocumentedNamePart><NamePartValue ScriptID="215">Vik P</NamePartValue></DocumentedNamePart></DocumentedName></Alias>
    <Alias FixedRef="41287" AliasTypeID="1403" Primary="true" LowQuality="false"><DocumentedName ID="3" DocNameStatusID="1">
     <DocumentedNamePart><NamePartValue NamePartGroupID="5" ScriptID="215">PETROV</NamePartValue></DocumentedNamePart>
     <DocumentedNamePart><NamePartValue NamePartGroupID="6" ScriptID="215">Viktor</NamePartValue></DocumentedNamePart>
    </DocumentedName></Alias></Identity>
   <Feature ID="10" FeatureTypeID="8"><FeatureVersion ID="11"><VersionDetail DetailTypeID="1">Russia</VersionDetail></FeatureVersion></Feature>
   <Feature ID="12" FeatureTypeID="345"><FeatureVersion ReliabilityID="1" ID="13"><Comment/><VersionDetail DetailTypeID="1432">0x8576aCC5C05D6Ce88f4e49bf65BdF0C62F91353C</VersionDetail></FeatureVersion><IdentityReference IdentityID="1"/></Feature>
   <Feature ID="14" FeatureTypeID="345"><FeatureVersion ID="15"><VersionDetail DetailTypeID="1432">0x8576acc5c05d6ce88f4e49bf65bdf0c62f91353c</VersionDetail></FeatureVersion></Feature>
   <Feature ID="16" FeatureTypeID="999"><FeatureVersion ID="17"><VersionDetail DetailTypeID="1432">DQnHWq5xCHqZrvUELGMoHH1T2HhXbYzXzv</VersionDetail></FeatureVersion></Feature>
  </Profile></DistinctParty>
  <DistinctParty FixedRef="50001"><Profile ID="50001"><Identity ID="4" Primary="true">
    <Alias Primary="true"><DocumentedName><DocumentedNamePart><NamePartValue>GARANTEX EUROPE OU &amp; CO</NamePartValue></DocumentedNamePart></DocumentedName></Alias></Identity>
   <Feature ID="20" FeatureTypeID="344"><FeatureVersion ID="21"><VersionDetail DetailTypeID="1432">bc1qkp8mz2fz9hpgmnsrfm4pa5rzkljh7ry6x2fhp4</VersionDetail></FeatureVersion></Feature>
  </Profile></DistinctParty>
  <DistinctParty FixedRef="60001"><Profile ID="60001"><Identity ID="5"><Alias Primary="true"><DocumentedName><DocumentedNamePart><NamePartValue>NO CRYPTO LTD</NamePartValue></DocumentedNamePart></DocumentedName></Alias></Identity></Profile></DistinctParty>
 </DistinctParties></Sanctions>`);
assert.equal(adv.version, "2026-10-09");
assert.equal(adv.addresses.length, 3);   // duplicate ETH (case only) dropped
assert.deepEqual(adv.addresses[0], { asset: "ETH", address: "0x8576aCC5C05D6Ce88f4e49bf65BdF0C62F91353C",
  name: "PETROV Viktor", uid: "41287" });
assert.deepEqual(adv.addresses[1], { asset: "DOGE", address: "DQnHWq5xCHqZrvUELGMoHH1T2HhXbYzXzv",
  name: "PETROV Viktor", uid: "41287" });
assert.equal(adv.addresses[2].name, "GARANTEX EUROPE OU & CO");
assert.equal(normalizeAddress("0x8576aCC5C05D6Ce88f4e49bf65BdF0C62F91353C"), "0x8576acc5c05d6ce88f4e49bf65bdf0c62f91353c");
assert.equal(normalizeAddress("DQnHWq5xCHqZrvUELGMoHH1T2HhXbYzXzv"), "DQnHWq5xCHqZrvUELGMoHH1T2HhXbYzXzv");
assert.deepEqual(parseOFACCrypto("<Sanctions/>"), { version: null, addresses: [] });
console.log("OFAC crypto parser: ok");
